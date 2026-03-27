import { describe, expect, it } from "vitest";
import { convertPiMessagesToOracleMessages } from "./oci-stream.js";

describe("convertPiMessagesToOracleMessages", () => {
  it("keeps functionCall assistant turns for non-Gemini Oracle models", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "openai.gpt-5.4",
      messages: [
        {
          role: "user",
          content: "Use the read tool.",
        },
        {
          role: "assistant",
          content: [
            {
              type: "functionCall",
              id: "call_1",
              name: "read",
              arguments: { path: "README.md" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "file contents" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Use the read tool." }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [
          {
            id: "call_1",
            type: "FUNCTION",
            name: "read",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_1",
        content: [{ type: "TEXT", text: "file contents" }],
      },
    ]);
  });

  it("keeps legacy role=tool outputs with tool_call_id and string content", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "openai.gpt-5.4",
      messages: [
        {
          role: "user",
          content: "Use the read tool.",
        },
        {
          role: "assistant",
          content: [
            {
              type: "functionCall",
              id: "call_legacy",
              name: "read",
              arguments: { path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_legacy",
          tool_name: "read",
          content: "legacy file contents",
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Use the read tool." }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [
          {
            id: "call_legacy",
            type: "FUNCTION",
            name: "read",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_legacy",
        content: [{ type: "TEXT", text: "legacy file contents" }],
      },
    ]);
  });

  it("keeps legacy role=tool outputs with tool_use_id", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "openai.gpt-5.4",
      messages: [
        {
          role: "user",
          content: "Use the lookup tool.",
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolUse",
              id: "toolu_123",
              name: "lookup",
              input: { query: "alpha" },
            },
          ],
        },
        {
          role: "tool",
          tool_use_id: "toolu_123",
          content: [{ type: "text", text: "legacy lookup result" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Use the lookup tool." }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [
          {
            id: "toolu_123",
            type: "FUNCTION",
            name: "lookup",
            arguments: '{"query":"alpha"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "toolu_123",
        content: [{ type: "TEXT", text: "legacy lookup result" }],
      },
    ]);
  });

  it("pairs Gemini functionCall blocks with their matching tool results", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "google.gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: "Run both tools.",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Calling tools now." },
            {
              type: "functionCall",
              id: "call_1",
              name: "lookup",
              arguments: { query: "alpha" },
            },
            {
              type: "functionCall",
              id: "call_2",
              name: "lookup",
              arguments: { query: "beta" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "alpha result" }],
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          content: [{ type: "text", text: "beta result" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Run both tools." }],
      },
      {
        role: "ASSISTANT",
        content: [{ type: "TEXT", text: "Calling tools now." }],
        toolCalls: [
          {
            id: "call_1",
            type: "FUNCTION",
            name: "lookup",
            arguments: '{"query":"alpha"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_1",
        content: [{ type: "TEXT", text: "alpha result" }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [
          {
            id: "call_2",
            type: "FUNCTION",
            name: "lookup",
            arguments: '{"query":"beta"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_2",
        content: [{ type: "TEXT", text: "beta result" }],
      },
    ]);
  });

  it("pairs Gemini functionCall blocks with matching legacy role=tool outputs", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "google.gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: "Run both tools.",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Calling tools now." },
            {
              type: "functionCall",
              id: "call_1",
              name: "lookup",
              arguments: { query: "alpha" },
            },
            {
              type: "functionCall",
              id: "call_2",
              name: "lookup",
              arguments: { query: "beta" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          tool_name: "lookup",
          content: "alpha legacy result",
        },
        {
          role: "tool",
          tool_call_id: "call_2",
          tool_name: "lookup",
          content: "beta legacy result",
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Run both tools." }],
      },
      {
        role: "ASSISTANT",
        content: [{ type: "TEXT", text: "Calling tools now." }],
        toolCalls: [
          {
            id: "call_1",
            type: "FUNCTION",
            name: "lookup",
            arguments: '{"query":"alpha"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_1",
        content: [{ type: "TEXT", text: "alpha legacy result" }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [
          {
            id: "call_2",
            type: "FUNCTION",
            name: "lookup",
            arguments: '{"query":"beta"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_2",
        content: [{ type: "TEXT", text: "beta legacy result" }],
      },
    ]);
  });
});
