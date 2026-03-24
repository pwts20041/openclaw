import Foundation

enum ExecAllowlistMatcher {
    static func match(
        entries: [ExecAllowlistEntry],
        resolution: ExecCommandResolution?,
        command: [String]? = nil
    ) -> ExecAllowlistEntry? {
        guard let resolution, !entries.isEmpty else { return nil }
        let rawExecutable = resolution.rawExecutable
        let resolvedPath = resolution.resolvedPath

        for entry in entries {
            switch ExecApprovalHelpers.validateAllowlistPattern(entry.pattern) {
            case let .valid(pattern):
                let target = resolvedPath ?? rawExecutable
                if self.matches(pattern: pattern, target: target) {
                    // For exact-match entries, also require args to match element-by-element.
                    // Unwrap dispatch wrappers (env, nice, etc.) first, matching the
                    // unwrapping done when persisting entries via allowlistEntry().
                    if entry.matchMode == "exact", let requiredArgs = entry.args {
                        let effective = command.map {
                            ExecEnvInvocationUnwrapper.unwrapDispatchWrappersForResolution($0)
                        } ?? []
                        let commandArgs = Array(effective.dropFirst())
                        guard commandArgs == requiredArgs else { continue }
                    }
                    return entry
                }
            case .invalid:
                continue
            }
        }
        return nil
    }

    static func matchAll(
        entries: [ExecAllowlistEntry],
        resolutions: [ExecCommandResolution],
        command: [String]? = nil
    ) -> [ExecAllowlistEntry] {
        guard !entries.isEmpty, !resolutions.isEmpty else { return [] }
        var matches: [ExecAllowlistEntry] = []
        matches.reserveCapacity(resolutions.count)
        for resolution in resolutions {
            guard let match = self.match(entries: entries, resolution: resolution, command: command) else {
                return []
            }
            matches.append(match)
        }
        return matches
    }

    private static func matches(pattern: String, target: String) -> Bool {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let expanded = trimmed.hasPrefix("~") ? (trimmed as NSString).expandingTildeInPath : trimmed
        let normalizedPattern = self.normalizeMatchTarget(expanded)
        let normalizedTarget = self.normalizeMatchTarget(target)
        guard let regex = self.regex(for: normalizedPattern) else { return false }
        let range = NSRange(location: 0, length: normalizedTarget.utf16.count)
        return regex.firstMatch(in: normalizedTarget, options: [], range: range) != nil
    }

    private static func normalizeMatchTarget(_ value: String) -> String {
        value.replacingOccurrences(of: "\\\\", with: "/").lowercased()
    }

    private static func regex(for pattern: String) -> NSRegularExpression? {
        var regex = "^"
        var idx = pattern.startIndex
        while idx < pattern.endIndex {
            let ch = pattern[idx]
            if ch == "*" {
                let next = pattern.index(after: idx)
                if next < pattern.endIndex, pattern[next] == "*" {
                    regex += ".*"
                    idx = pattern.index(after: next)
                } else {
                    regex += "[^/]*"
                    idx = next
                }
                continue
            }
            if ch == "?" {
                regex += "."
                idx = pattern.index(after: idx)
                continue
            }
            regex += NSRegularExpression.escapedPattern(for: String(ch))
            idx = pattern.index(after: idx)
        }
        regex += "$"
        return try? NSRegularExpression(pattern: regex, options: [.caseInsensitive])
    }
}
