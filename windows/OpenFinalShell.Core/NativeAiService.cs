using System.Net.Http.Headers;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

/// <summary>Native OpenAI-compatible provider service. Tokens never leave NativeStore.</summary>
public sealed class NativeAiService : IDisposable
{
    private const int MaxInputCharacters = 32768;
    private const int MaxMessages = 64;
    private const int MaxResponseCharacters = 1_000_000;
    private const int MaxImageBytes = 8 * 1024 * 1024;
    private static readonly TimeSpan ChatTimeout = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(30);
    private readonly NativeStore store;
    private readonly HttpClient http;
    private readonly bool ownsHttp;

    public NativeAiService(NativeStore store, HttpClient? httpClient = null)
    {
        this.store = store;
        http = httpClient ?? new HttpClient();
        ownsHttp = httpClient == null;
        http.Timeout = ChatTimeout;
    }

    public IReadOnlyList<AiProviderProfile> ListProviders() => ExportProfiles(store).Select(ParseProvider).ToArray();

    // Shared encrypted exports use aiProfiles/apiKeyRef. Read older native
    // aiProviders/tokenRef in place, without rewriting or deleting their data.
    public static IReadOnlyList<JsonObject> ExportProfiles(NativeStore store) => store.List("aiProfiles")
        .Concat(store.List("aiProviders")).GroupBy(item => item["id"]!.GetValue<string>(), StringComparer.Ordinal)
        .Select(group => {
            var value = (JsonObject)group.First().DeepClone();
            value["apiKeyRef"] ??= value["tokenRef"]?.DeepClone(); value.Remove("tokenRef");
            value["hasToken"] = value["apiKeyRef"] is JsonValue;
            return value;
        }).ToArray();

    private JsonObject? FindProvider(string id) => store.Find("aiProfiles", id) ?? store.Find("aiProviders", id);

    public AiProviderProfile SaveProvider(AiProviderDraft draft)
    {
        var baseUrl = NormalizeBaseUrl(draft.BaseUrl);
        var id = string.IsNullOrWhiteSpace(draft.Id) ? Guid.NewGuid().ToString("N") : draft.Id.Trim();
        var canonical = store.Find("aiProfiles", id);
        var legacy = store.Find("aiProviders", id);
        var existing = canonical ?? legacy;
        if (draft.Id is not null && existing is null) throw new KeyNotFoundException("AI provider not found.");
        var tokenRef = (existing?["apiKeyRef"] ?? existing?["tokenRef"])?.GetValue<string>();
        var token = string.IsNullOrWhiteSpace(draft.Token) ? null : draft.Token.Trim();
        var clearToken = draft.ClearToken && token is null;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var created = existing?["createdAt"]?.GetValue<long>() ?? now;
        var payload = existing == null ? new JsonObject() : (JsonObject)existing.DeepClone();
        payload.Remove("_revision"); payload.Remove("tokenRef");
        payload["id"] = id; payload["name"] = Require(draft.Name, 100); payload["baseUrl"] = baseUrl.ToString();
        payload["model"] = Require(draft.Model, 200); payload["enabled"] = draft.Enabled;
        payload["apiKeyRef"] = tokenRef;
        payload["hasToken"] = token is not null || !clearToken && tokenRef is not null;
        payload["createdAt"] = created; payload["updatedAt"] = now;
        var obsoleteReferences = new[] {
            (canonical?["apiKeyRef"] ?? canonical?["tokenRef"])?.GetValue<string>(),
            (legacy?["apiKeyRef"] ?? legacy?["tokenRef"])?.GetValue<string>()
        };
        NativeStore.EntityRevision[] duplicateEntities = legacy == null ? Array.Empty<NativeStore.EntityRevision>() : [
            new NativeStore.EntityRevision("aiProviders", id, legacy["_revision"]?.GetValue<long>() ?? 0)
        ];
        var result = store.SaveWithSecret("aiProfiles", id, payload, "apiKeyRef", token, clearToken,
            canonical?["_revision"]?.GetValue<long>() ?? 0, duplicateEntities, obsoleteReferences);
        payload["apiKeyRef"] = result.SecretReference;
        payload["hasToken"] = result.SecretReference is not null;
        return ParseProvider(payload);
    }

    public void DeleteProvider(string id)
    {
        var canonical = store.Find("aiProfiles", id);
        var legacy = store.Find("aiProviders", id);
        if (canonical == null && legacy == null) throw new KeyNotFoundException("AI provider not found.");
        var entities = new List<NativeStore.EntityRevision>();
        var references = new List<string?>();
        foreach (var (kind, profile) in new[] { ("aiProfiles", canonical), ("aiProviders", legacy) })
        {
            if (profile == null) continue;
            entities.Add(new(kind, id, profile["_revision"]?.GetValue<long>() ?? 0));
            references.Add((profile["apiKeyRef"] ?? profile["tokenRef"])?.GetValue<string>());
        }
        store.DeleteWithSecrets(entities, references);
    }

    private void EnsureAssistantEnabled()
    {
        if (!NativeSettings.Load(store).Get("aiAssistantEnabled", false))
            throw new InvalidOperationException("AI assistant is disabled. Enable it in settings to use AI services.");
    }

    public async Task<IReadOnlyList<AiModelInfo>> DiscoverModelsAsync(Uri baseUrl, string? token, CancellationToken cancellation = default)
    {
        EnsureAssistantEnabled();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(ProbeTimeout);
        using var response = await SendAsync(HttpMethod.Get, Endpoint(baseUrl, "models"), token, null, timeout.Token);
        var document = await ReadJsonAsync(response, timeout.Token, 4 * 1024 * 1024);
        var models = new List<AiModelInfo>();
        if (document["data"] is JsonArray values)
            foreach (var value in values.OfType<JsonObject>())
            {
                var id = value["id"]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(id) || id.Length > 200) continue;
                models.Add(new(id, value["owned_by"]?.GetValue<string>(), value["context_window"]?.GetValue<int>()));
            }
        if (models.Count == 0) throw new InvalidDataException("AI provider returned no models.");
        return models;
    }

    public async Task<AiConnectionTestResult> TestConnectionAsync(string providerId, CancellationToken cancellation = default)
    {
        EnsureAssistantEnabled();
        var provider = GetProvider(providerId);
        var token = GetToken(providerId);
        var payload = new JsonObject {
            ["model"] = provider.Model,
            ["stream"] = false,
            ["max_tokens"] = 64,
            ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "ping" })
        };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(ProbeTimeout);
        var started = Stopwatch.GetTimestamp();
        using var response = await SendAsync(HttpMethod.Post, Endpoint(provider.BaseUrl, "chat/completions"), token, payload, timeout.Token);
        response.EnsureSuccessStatusCode();
        await ReadLimitedAsync(response, 64 * 1024, timeout.Token);
        return new(provider.Model, (int)Math.Min(int.MaxValue, Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds)));
    }

    public async Task<AiImageCapabilityResult> TestImageCapabilityAsync(Uri baseUrl, string model, string? token, CancellationToken cancellation = default)
    {
        EnsureAssistantEnabled();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(ProbeTimeout);
        var safeBase = NormalizeBaseUrl(baseUrl);
        var safeModel = Require(model, 200);
        var png = Convert.ToBase64String(Convert.FromHexString("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000B49444154789C636000020000050001A5F645400000000049454E44AE426082"));
        var payload = new JsonObject
        {
            ["model"] = safeModel,
            ["stream"] = false,
            ["max_tokens"] = 8,
            ["messages"] = new JsonArray(new JsonObject
            {
                ["role"] = "user",
                ["content"] = new JsonArray(
                    new JsonObject { ["type"] = "text", ["text"] = "Reply with one word about the attached image." },
                    new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = "data:image/png;base64," + png, ["detail"] = "low" } })
            })
        };
        using var response = await SendAsync(HttpMethod.Post, Endpoint(safeBase, "chat/completions"), token, payload, timeout.Token);
        if (response.IsSuccessStatusCode)
        {
            var body = await ReadLimitedTextAsync(response, 64 * 1024, timeout.Token);
            if (TryReadAnswerText(body) is { Length: > 0 })
                return new(safeModel, "yes", "accepted", "Provider accepted a minimal image request.", (int)response.StatusCode);
            return new(safeModel, "unknown", "inconclusive", "Provider returned no usable image answer.", (int)response.StatusCode);
        }
        var status = (int)response.StatusCode;
        if (status is 401 or 403 or 404 or 429 || status >= 500)
            throw new HttpRequestException(ErrorForStatus(status), null, response.StatusCode);
        var errorBody = await ReadLimitedTextAsync(response, 64 * 1024, timeout.Token);
        var (code, detail) = ReadErrorDetails(errorBody, status);
        var unsupportedCode = code is "image_input_not_supported" or "unsupported_image_input" or "vision_not_supported";
        var unsupportedMessage = Regex.IsMatch(detail,
            @"(?:model[^.\n]{0,100}(?:does not|doesn't|cannot|can't) support (?:image|vision|multimodal)|image_url is only supported by certain models|(?:该|当前|此)模型不支持(?:图片|图像|视觉|多模态))",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if ((status is 400 or 415 or 422) && (unsupportedCode || unsupportedMessage))
            return new(safeModel, "no", "unsupported", "Provider reports that image input is unsupported.", status);
        return new(safeModel, "unknown", "inconclusive", detail, status);
    }

    public async IAsyncEnumerable<string> StreamChatAsync(string providerId, IReadOnlyList<AiChatMessage> messages,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellation = default)
    {
        EnsureAssistantEnabled();
        ValidateMessages(messages);
        var provider = GetProvider(providerId);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(ChatTimeout);
        var payload = new JsonObject {
            ["model"] = provider.Model,
            ["stream"] = true,
            ["temperature"] = 0.7,
            ["max_tokens"] = 4096,
            ["messages"] = new JsonArray(messages.Select(ToJson).ToArray())
        };
        using var response = await SendAsync(HttpMethod.Post, Endpoint(provider.BaseUrl, "chat/completions"), GetToken(providerId), payload, timeout.Token);
        response.EnsureSuccessStatusCode();
        using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var emitted = 0;
        while (await reader.ReadLineAsync(timeout.Token) is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;
            var data = line[5..].Trim();
            if (data == "[DONE]") yield break;
            JsonObject? frame;
            try { frame = JsonNode.Parse(data)?.AsObject(); } catch (JsonException) { continue; }
            var text = frame?["choices"]?[0]?["delta"]?["content"]?.GetValue<string>();
            if (string.IsNullOrEmpty(text)) text = frame?["choices"]?[0]?["message"]?["content"]?.GetValue<string>();
            if (string.IsNullOrEmpty(text)) continue;
            emitted += text.Length;
            if (emitted > MaxResponseCharacters) throw new InvalidDataException("AI response exceeded the native limit.");
            yield return text;
        }
    }

    /// <summary>Completes a chat request in one JSON response, matching Electron's non-stream mode.</summary>
    public async Task<string> CompleteChatAsync(string providerId, IReadOnlyList<AiChatMessage> messages,
        CancellationToken cancellation = default)
    {
        EnsureAssistantEnabled();
        ValidateMessages(messages);
        var provider = GetProvider(providerId);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(ChatTimeout);
        var payload = new JsonObject {
            ["model"] = provider.Model,
            ["stream"] = false,
            ["temperature"] = 0.7,
            ["max_tokens"] = 4096,
            ["messages"] = new JsonArray(messages.Select(ToJson).ToArray())
        };
        using var response = await SendAsync(HttpMethod.Post, Endpoint(provider.BaseUrl, "chat/completions"), GetToken(providerId), payload, timeout.Token);
        var document = await ReadJsonAsync(response, timeout.Token);
        var text = TryReadAnswerText(document.ToJsonString());
        if (string.IsNullOrEmpty(text))
        {
            var error = document["error"]?["message"]?.GetValue<string>();
            throw new InvalidDataException(string.IsNullOrWhiteSpace(error) ? "AI provider returned no answer." : error);
        }
        if (text.Length > MaxResponseCharacters) throw new InvalidDataException("AI response exceeded the native limit.");
        return text;
    }

    private static void ValidateMessages(IReadOnlyList<AiChatMessage> messages)
    {
        if (messages.Count == 0 || messages.Count > MaxMessages || messages.Sum(message => message.Content.Length) > MaxInputCharacters)
            throw new ArgumentException("AI input is empty or exceeds the native limit.", nameof(messages));
        if (messages.Any(message => message.Role is not ("system" or "user" or "assistant") || message.Content.Length > MaxInputCharacters))
            throw new ArgumentException("AI message role or content is invalid.", nameof(messages));
        ValidateImages(messages);
    }

    private static JsonObject ToJson(AiChatMessage message)
    {
        if (message.Images is not { Count: > 0 }) return new JsonObject { ["role"] = message.Role, ["content"] = message.Content };
        var content = new JsonArray { new JsonObject { ["type"] = "text", ["text"] = message.Content } };
        foreach (var image in message.Images)
            content.Add(new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = image.DataUrl, ["detail"] = image.Detail } });
        return new JsonObject { ["role"] = message.Role, ["content"] = content };
    }

    private static void ValidateImages(IReadOnlyList<AiChatMessage> messages)
    {
        if (messages.Sum(message => (message.Images?.Count ?? 0) + (string.IsNullOrEmpty(message.Content) ? 0 : 1)) > 32)
            throw new ArgumentException("AI content contains too many parts.", nameof(messages));
        long aggregate = 0;
        foreach (var image in messages.SelectMany(message => message.Images ?? []))
        {
            if (image.DataUrl.Length > MaxImageBytes * 2 || !image.DataUrl.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("AI images must be local-supported data URLs below the size limit.", nameof(messages));
            var comma = image.DataUrl.IndexOf(',');
            if (comma < 0 || !image.DataUrl[..comma].EndsWith(";base64", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("AI images must use a base64 data URL.", nameof(messages));
            byte[] bytes;
            try { bytes = Convert.FromBase64String(image.DataUrl[(comma + 1)..]); }
            catch (FormatException error) { throw new ArgumentException("AI image data is invalid.", nameof(messages), error); }
            aggregate += bytes.LongLength;
            if (bytes.LongLength > MaxImageBytes || aggregate > MaxImageBytes) throw new ArgumentException("AI image request exceeds the native size limit.", nameof(messages));
            if (image.Detail is not ("low" or "high" or "auto")) throw new ArgumentException("AI image detail is invalid.", nameof(messages));
            var media = image.DataUrl[5..comma].Split(';')[0].ToLowerInvariant();
            if (media is not ("image/png" or "image/jpeg" or "image/webp" or "image/gif")) throw new ArgumentException("Unsupported AI image format.", nameof(messages));
        }
    }

    private static (string? Code, string Message) ReadErrorDetails(string body, int status)
    {
        try
        {
            static string? StringValue(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var result) ? result : null;
            var json = JsonNode.Parse(body) as JsonObject;
            var code = StringValue(json?["error"]?["code"]);
            var message = StringValue(json?["error"]?["message"]) ?? StringValue(json?["message"]);
            if (!string.IsNullOrWhiteSpace(message)) return (code, message[..Math.Min(message.Length, 4000)]);
            return (code, ErrorForStatus(status));
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException) { }
        return (null, ErrorForStatus(status));
    }

    private static string ErrorForStatus(int status) => status switch
    {
        401 => "AI token is invalid or expired.",
        403 => "AI provider denied the request.",
        404 => "AI model or endpoint was not found.",
        429 => "AI provider is rate limiting requests.",
        >= 500 => "AI provider is temporarily unavailable.",
        _ => $"Provider returned HTTP {status}."
    };

    private AiProviderProfile GetProvider(string id) => ParseProvider(FindProvider(id) ?? throw new KeyNotFoundException("AI provider not found."));
    public string? GetToken(string id)
    {
        var value = FindProvider(id);
        return (value?["apiKeyRef"] ?? value?["tokenRef"])?.GetValue<string>() is { } reference ? store.ReadSecret(reference) : null;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, Uri endpoint, string? token, JsonObject? payload, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(method, endpoint);
        if (!string.IsNullOrWhiteSpace(token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var streaming = payload?["stream"] is JsonValue streamValue && streamValue.TryGetValue<bool>(out var streamEnabled) && streamEnabled;
        if (streaming) request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (payload != null) request.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
        return await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
    }

    private static async Task<JsonObject> ReadJsonAsync(HttpResponseMessage response, CancellationToken cancellation, int maxBytes = MaxResponseCharacters)
    {
        response.EnsureSuccessStatusCode();
        var text = await ReadLimitedTextAsync(response, maxBytes, cancellation);
        return JsonNode.Parse(text) as JsonObject ?? throw new InvalidDataException("AI provider returned invalid JSON.");
    }

    private static string? TryReadAnswerText(string body)
    {
        try
        {
            var document = JsonNode.Parse(body)?.AsObject();
            var content = document?["choices"]?[0]?["message"]?["content"];
            var text = content is JsonValue value && value.TryGetValue<string>(out var scalar) ? scalar : null;
            if (string.IsNullOrEmpty(text) && content is JsonArray parts)
                text = string.Concat(parts.OfType<JsonObject>().Select(part => part["text"] is JsonValue partText && partText.TryGetValue<string>(out var value) ? value : string.Empty));
            return string.IsNullOrWhiteSpace(text) ? null : text;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException) { return null; }
    }

    private static async Task<string> ReadLimitedTextAsync(HttpResponseMessage response, int maxBytes, CancellationToken cancellation)
    {
        if (response.Content.Headers.ContentLength is > 0 and var length && length > maxBytes)
            throw new InvalidDataException("AI response exceeded the native limit.");
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        await using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        while (true)
        {
            var read = await stream.ReadAsync(chunk, cancellation);
            if (read == 0) return Encoding.UTF8.GetString(buffer.ToArray());
            if (buffer.Length + read > maxBytes) throw new InvalidDataException("AI response exceeded the native limit.");
            await buffer.WriteAsync(chunk.AsMemory(0, read), cancellation);
        }
    }

    private static async Task ReadLimitedAsync(HttpResponseMessage response, int maxBytes, CancellationToken cancellation)
    {
        if (response.Content.Headers.ContentLength is > 0 and var length && length > maxBytes)
            throw new InvalidDataException("AI response exceeded the native limit.");
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        var buffer = new byte[8192];
        var total = 0;
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellation);
            if (read == 0) return;
            total += read;
            if (total > maxBytes) throw new InvalidDataException("AI response exceeded the native limit.");
        }
    }

    private static AiProviderProfile ParseProvider(JsonObject value)
    {
        var url = NormalizeBaseUrl(new Uri(value["baseUrl"]?.GetValue<string>() ?? throw new InvalidDataException("Missing AI base URL.")));
        return new(value["id"]?.GetValue<string>() ?? throw new InvalidDataException("Missing AI provider id."),
            value["name"]?.GetValue<string>() ?? "", url, value["model"]?.GetValue<string>() ?? "", value["enabled"]?.GetValue<bool>() ?? false,
            (value["apiKeyRef"] ?? value["tokenRef"]) is JsonValue, value["createdAt"]?.GetValue<long>() ?? 0, value["updatedAt"]?.GetValue<long>() ?? 0);
    }

    private static Uri NormalizeBaseUrl(Uri value)
    {
        if (value.UserInfo.Length != 0 || !string.IsNullOrEmpty(value.Query) || !string.IsNullOrEmpty(value.Fragment)) throw new ArgumentException("AI endpoint cannot contain credentials, query or fragment.");
        if (value.Scheme != Uri.UriSchemeHttps && !(value.Scheme == Uri.UriSchemeHttp && IsLoopback(value.Host))) throw new ArgumentException("AI endpoint must use HTTPS unless it is loopback HTTP.");
        var path = value.AbsolutePath.TrimEnd('/');
        if (path.Length == 0) path = "/v1";
        return new UriBuilder(value) { Path = path, Query = "", Fragment = "" }.Uri;
    }

    private static bool IsLoopback(string host) => host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || host.Equals("127.0.0.1") || host.Equals("::1");
    private static Uri Endpoint(Uri baseUrl, string suffix) => new(baseUrl.ToString().TrimEnd('/') + "/" + suffix);
    private static string Require(string? value, int max) => !string.IsNullOrWhiteSpace(value) && value.Trim().Length <= max ? value.Trim() : throw new ArgumentException("AI provider field is invalid.");
    public void Dispose() { if (ownsHttp) http.Dispose(); }
}
