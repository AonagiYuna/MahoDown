using System.Text.Json;

namespace MahoDown.Core.Bridge;

public static class BridgeJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };
}

public sealed record BridgeRequest(string Id, string Command, JsonElement Payload);

public sealed record BridgeResponse(string Id, bool Ok, JsonElement? Payload, string? ErrorCode, string? ErrorMessage)
{
    public static BridgeResponse Success(string id, object? payload = null) =>
        new(
            id,
            true,
            payload is null ? null : JsonSerializer.SerializeToElement(payload, BridgeJson.Options),
            null,
            null);

    public static BridgeResponse Failure(string id, string errorCode, string errorMessage) =>
        new(id, false, null, errorCode, errorMessage);
}
