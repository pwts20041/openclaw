package ai.openclaw.app.node

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsManagerTest {
  private val json = SmsManager.JsonConfig

  @Test
  fun parseParamsRejectsEmptyPayload() {
    val result = SmsManager.parseParams("", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: paramsJSON required", error.error)
  }

  @Test
  fun parseParamsRejectsInvalidJson() {
    val result = SmsManager.parseParams("not-json", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseParamsRejectsNonObjectJson() {
    val result = SmsManager.parseParams("[]", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseParamsRejectsMissingTo() {
    val result = SmsManager.parseParams("{\"message\":\"Hi\"}", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: 'to' phone number required", error.error)
    assertEquals("Hi", error.message)
  }

  @Test
  fun parseParamsRejectsMissingMessage() {
    val result = SmsManager.parseParams("{\"to\":\"+1234\"}", json)
    assertTrue(result is SmsManager.ParseResult.Error)
    val error = result as SmsManager.ParseResult.Error
    assertEquals("INVALID_REQUEST: 'message' text required", error.error)
    assertEquals("+1234", error.to)
  }

  @Test
  fun parseParamsTrimsToField() {
    val result = SmsManager.parseParams("{\"to\":\"  +1555  \",\"message\":\"Hello\"}", json)
    assertTrue(result is SmsManager.ParseResult.Ok)
    val ok = result as SmsManager.ParseResult.Ok
    assertEquals("+1555", ok.params.to)
    assertEquals("Hello", ok.params.message)
  }

  @Test
  fun parseQueryParamsDefaultsWhenPayloadEmpty() {
    val result = SmsManager.parseQueryParams(null, json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(25, ok.params.limit)
    assertEquals(0, ok.params.offset)
    assertEquals(null, ok.params.startTime)
    assertEquals(null, ok.params.endTime)
  }

  @Test
  fun parseQueryParamsRejectsInvalidJson() {
    val result = SmsManager.parseQueryParams("not-json", json)
    assertTrue(result is SmsManager.QueryParseResult.Error)
    val error = result as SmsManager.QueryParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseQueryParamsRejectsInvertedTimeRange() {
    val result = SmsManager.parseQueryParams("{\"startTime\":200,\"endTime\":100}", json)
    assertTrue(result is SmsManager.QueryParseResult.Error)
    val error = result as SmsManager.QueryParseResult.Error
    assertEquals("INVALID_REQUEST: startTime must be less than or equal to endTime", error.error)
  }

  @Test
  fun parseQueryParamsClampsLimitAndOffset() {
    val result = SmsManager.parseQueryParams("{\"limit\":999,\"offset\":-5}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(200, ok.params.limit)
    assertEquals(0, ok.params.offset)
  }

  @Test
  fun parseQueryParamsParsesAllSupportedFields() {
    val result = SmsManager.parseQueryParams(
      """
      {
        "startTime": 100,
        "endTime": 200,
        "contactName": " Leah ",
        "phoneNumber": " +1555 ",
        "keyword": " ping ",
        "type": 1,
        "isRead": true,
        "limit": 10,
        "offset": 2
      }
      """.trimIndent(),
      json,
    )
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(100L, ok.params.startTime)
    assertEquals(200L, ok.params.endTime)
    assertEquals("Leah", ok.params.contactName)
    assertEquals("+1555", ok.params.phoneNumber)
    assertEquals("ping", ok.params.keyword)
    assertEquals(1, ok.params.type)
    assertEquals(true, ok.params.isRead)
    assertEquals(10, ok.params.limit)
    assertEquals(2, ok.params.offset)
  }

  @Test
  fun buildPayloadJsonEscapesFields() {
    val payload = SmsManager.buildPayloadJson(
      json = json,
      ok = false,
      to = "+1\"23",
      error = "SMS_SEND_FAILED: \"nope\"",
    )
    val parsed = json.parseToJsonElement(payload).jsonObject
    assertEquals("false", parsed["ok"]?.jsonPrimitive?.content)
    assertEquals("+1\"23", parsed["to"]?.jsonPrimitive?.content)
    assertEquals("SMS_SEND_FAILED: \"nope\"", parsed["error"]?.jsonPrimitive?.content)
  }

  @Test
  fun buildQueryPayloadJsonIncludesCountAndMessages() {
    val payload = SmsManager.buildQueryPayloadJson(
      json = json,
      ok = true,
      messages = listOf(
        SmsManager.SmsMessage(
          id = 1L,
          threadId = 2L,
          address = "+1555",
          person = null,
          date = 123L,
          dateSent = 124L,
          read = true,
          type = 1,
          body = "hello",
          status = 0,
        )
      ),
    )
    val parsed = json.parseToJsonElement(payload).jsonObject
    assertEquals("true", parsed["ok"]?.jsonPrimitive?.content)
    assertEquals(1, parsed["count"]?.jsonPrimitive?.content?.toInt())
    val messages = parsed["messages"]?.jsonArray
    assertEquals(1, messages?.size)
    assertEquals("hello", messages?.get(0)?.jsonObject?.get("body")?.jsonPrimitive?.content)
  }

  @Test
  fun buildQueryPayloadJsonIncludesErrorOnFailure() {
    val payload = SmsManager.buildQueryPayloadJson(
      json = json,
      ok = false,
      messages = emptyList(),
      error = "SMS_QUERY_FAILED: nope",
    )
    val parsed = json.parseToJsonElement(payload).jsonObject
    assertEquals("false", parsed["ok"]?.jsonPrimitive?.content)
    assertEquals(0, parsed["count"]?.jsonPrimitive?.content?.toInt())
    assertEquals("SMS_QUERY_FAILED: nope", parsed["error"]?.jsonPrimitive?.content)
  }

  @Test
  fun buildSendPlanUsesMultipartWhenMultipleParts() {
    val plan = SmsManager.buildSendPlan("hello") { listOf("a", "b") }
    assertTrue(plan.useMultipart)
    assertEquals(listOf("a", "b"), plan.parts)
  }

  @Test
  fun buildSendPlanFallsBackToSinglePartWhenDividerEmpty() {
    val plan = SmsManager.buildSendPlan("hello") { emptyList() }
    assertFalse(plan.useMultipart)
    assertEquals(listOf("hello"), plan.parts)
  }

  @Test
  fun parseQueryParamsAcceptsEmptyPayload() {
    val result = SmsManager.parseQueryParams(null, json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(25, ok.params.limit)
    assertEquals(0, ok.params.offset)
  }

  @Test
  fun parseQueryParamsRejectsNonObjectJson() {
    val result = SmsManager.parseQueryParams("[]", json)
    assertTrue(result is SmsManager.QueryParseResult.Error)
    val error = result as SmsManager.QueryParseResult.Error
    assertEquals("INVALID_REQUEST: expected JSON object", error.error)
  }

  @Test
  fun parseQueryParamsParsesLimitAndOffset() {
    val result = SmsManager.parseQueryParams("{\"limit\":10,\"offset\":5}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(10, ok.params.limit)
    assertEquals(5, ok.params.offset)
  }

  @Test
  fun parseQueryParamsClampsLimitRange() {
    val result = SmsManager.parseQueryParams("{\"limit\":300}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(200, ok.params.limit)
  }

  @Test
  fun parseQueryParamsParsesPhoneNumber() {
    val result = SmsManager.parseQueryParams("{\"phoneNumber\":\"+1234567890\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("+1234567890", ok.params.phoneNumber)
  }

  @Test
  fun parseQueryParamsParsesContactName() {
    val result = SmsManager.parseQueryParams("{\"contactName\":\"lixuankai\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("lixuankai", ok.params.contactName)
  }

  @Test
  fun parseQueryParamsParsesKeyword() {
    val result = SmsManager.parseQueryParams("{\"keyword\":\"test\"}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals("test", ok.params.keyword)
  }

  @Test
  fun parseQueryParamsParsesTimeRange() {
    val result = SmsManager.parseQueryParams("{\"startTime\":1000,\"endTime\":2000}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(1000L, ok.params.startTime)
    assertEquals(2000L, ok.params.endTime)
  }

  @Test
  fun parseQueryParamsParsesType() {
    val result = SmsManager.parseQueryParams("{\"type\":1}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(1, ok.params.type)
  }

  @Test
  fun parseQueryParamsParsesReadStatus() {
    val result = SmsManager.parseQueryParams("{\"isRead\":true}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertEquals(true, ok.params.isRead)
  }

  @Test
  fun parseQueryParamsIncludeMmsDefaultsFalse() {
    val result = SmsManager.parseQueryParams("{}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertFalse(ok.params.includeMms)
  }

  @Test
  fun parseQueryParamsParsesIncludeMmsTrue() {
    val result = SmsManager.parseQueryParams("{\"includeMms\":true}", json)
    assertTrue(result is SmsManager.QueryParseResult.Ok)
    val ok = result as SmsManager.QueryParseResult.Ok
    assertTrue(ok.params.includeMms)
  }

  @Test
  fun toByPhoneLookupNumberStripsFormattingToDigits() {
    assertEquals("12107588120", SmsManager.toByPhoneLookupNumber("+1 (210) 758-8120"))
  }

  @Test
  fun normalizePhoneNumberOrNullReturnsNullForFormattingOnlyInput() {
    assertNull(SmsManager.normalizePhoneNumberOrNull("() -   "))
  }

  @Test
  fun normalizePhoneNumberOrNullKeepsUsableNormalizedNumber() {
    assertEquals("+15551234567", SmsManager.normalizePhoneNumberOrNull(" +1 (555) 123-4567 "))
  }

  @Test
  fun shouldCollectByPhoneMatchHonorsOffsetWindow() {
    assertFalse(SmsManager.shouldCollectByPhoneMatch(matchedRows = 1, offset = 1))
    assertTrue(SmsManager.shouldCollectByPhoneMatch(matchedRows = 2, offset = 1))
  }

  @Test
  fun isByPhonePageCompleteHonorsLimit() {
    assertFalse(SmsManager.isByPhonePageComplete(collectedRows = 2, limit = 3))
    assertTrue(SmsManager.isByPhonePageComplete(collectedRows = 3, limit = 3))
  }

  @Test
  fun normalizeProviderDateMillisConvertsSecondsToMillis() {
    assertEquals(1773944910000L, SmsManager.normalizeProviderDateMillis(1773944910L))
  }

  @Test
  fun normalizeProviderDateMillisKeepsMillisUnchanged() {
    assertEquals(1773944910123L, SmsManager.normalizeProviderDateMillis(1773944910123L))
  }
}
