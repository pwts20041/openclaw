package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession

class SmsHandler(
  private val sms: SmsManager,
) {
  suspend fun handleSmsSend(paramsJson: String?): GatewaySession.InvokeResult {
    val res = sms.send(paramsJson)
    if (res.ok) {
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    }
    return errorResult(res.error, defaultCode = "SMS_SEND_FAILED")
  }

  suspend fun handleSmsSearch(paramsJson: String?): GatewaySession.InvokeResult {
    val res = sms.search(paramsJson)
    if (res.ok) {
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    }
    return errorResult(res.error, defaultCode = "SMS_SEARCH_FAILED")
  }

  private fun errorResult(error: String?, defaultCode: String): GatewaySession.InvokeResult {
    val message = error ?: defaultCode
    val idx = message.indexOf(':')
    val code = if (idx > 0) message.substring(0, idx).trim() else defaultCode
    return GatewaySession.InvokeResult.error(code = code, message = message)
  }

  suspend fun handleSmsSearch(paramsJson: String?): GatewaySession.InvokeResult {
    val res = sms.search(paramsJson)
    if (res.ok) {
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    } else {
      val error = res.error ?: "SMS_SEARCH_FAILED"
      val idx = error.indexOf(':')
      val code = if (idx > 0) error.substring(0, idx).trim() else "SMS_SEARCH_FAILED"
      return GatewaySession.InvokeResult.error(code = code, message = error)
    }
  }
}
