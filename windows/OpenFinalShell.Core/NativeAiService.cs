using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenFinalShell.Core;

/// <summary>Native OpenAI-compatible provider service. Tokens never leave NativeStore.</summary>
public sealed class NativeAiService : IDisposable
{
    private const int MaxInputCharacters = 32768;
    private const int MaxResponseCharacters = 1_000_000;
    private const int MaxImageBytes = 8 * 1024 * 1024;
    private readonly NativeStore store;
    private readonly HttpClient http;
    private readonly bool ownsHttp;

    public NativeAiService(NativeStore store, HttpClient? httpClient = null)
    {
        this.store = store;
        http = httpClient ?? new HttpClient();
        ownsHttp = httpClient == null;
        http.Timeout = TimeSpan.FromSeconds(90);
    }

    public IReadOnlyList<AiProviderProfile> ListProviders() => store.List("aiProviders").Select(ParseProvider).ToArray();

    public AiProviderProfile SaveProvider(AiProviderDraft draft)
    {
        var baseUrl = NormalizeBaseUrl(draft.BaseUrl);
        var id = string.IsNullOrWhiteSpace(draft.Id) ? Guid.NewGuid().ToString("N") : draft.Id.Trim();
        var existing = store.Find("aiProviders", id);
        var tokenRef = existing?["tokenRef"]?.GetValue<string>();
        if (draft.ClearToken) tokenRef = null;
        if (!string.IsNullOrEmpty(draft.Token)) tokenRef = store.SaveSecret(draft.Token);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var created = existing?["createdAt"]?.GetValue<long>() ?? now;
        var payload = new JsonObject {
            ["id"] = id, ["name"] = Require(draft.Name, 100), ["baseUrl"] = baseUrl.ToString(),
            ["model"] = Require(draft.Model, 200), ["enabled"] = draft.Enabled,
            ["hasToken"] = tokenRef != null, ["tokenRef"] = tokenRef,
            ["createdAt"] = created, ["updatedAt"] = now
        };
        store.Save("aiProviders", id, payload, existing?["_revision"]?.GetValue<long>());
        return ParseProvider(payload);
    }

    public void DeleteProvider(string id)
    {
        var existing = store.Find("aiProviders", id) ?? throw new KeyNotFoundException("AI provider not found.");
        store.Delete("aiProviders", id, existing["_revision"]?.GetValue<long>() ?? 0);
    }

    public async Task<IReadOnlyList<AiModelInfo>> DiscoverModelsAsync(Uri baseUrl, string? token, CancellationToken cancellation = default)
    {
        using var response = await SendAsync(HttpMethod.Get, Endpoint(baseUrl, "models"), token, null, cancellation);
        var document = await ReadJsonAsync(response, cancellation);
        var models = new List<AiModelInfo>();
        if (document["data"] is JsonArray values)
            foreach (var value in values.OfType<JsonObject>())
            {
                var id = value["id"]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(id) || id.Length > 200) continue;
                models.Add(new(id, value["owned_by"]?.GetValue<string>(), value["context_window"]?.GetValue<int>()));
            }
        return models;
    }

    public async Task TestConnectionAsync(string providerId, CancellationToken cancellation = default)
    {
        var provider = GetProvider(providerId);
        var token = GetToken(providerId);
        using var response = await SendAsync(HttpMethod.Get, Endpoint(provider.BaseUrl, "models"), token, null, cancellation);
        response.EnsureSuccessStatusCode();
    }

    public async Task<AiImageCapabilityResult> TestImageCapabilityAsync(Uri baseUrl, string model, string? token, CancellationToken cancellation = default)
    {
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
        using var response = await SendAsync(HttpMethod.Post, Endpoint(safeBase, "chat/completions"), token, payload, cancellation);
        if (response.IsSuccessStatusCode)
            return new(safeModel, "yes", "accepted", "Provider accepted a minimal image request.", (int)response.StatusCode);
        var status = (int)response.StatusCode;
        if (status is 400 or 415 or 422)
            return new(safeModel, "no", "unsupported", "Provider rejected the image request format or capability.", status);
        var detail = await ReadErrorMessageAsync(response, cancellation);
        return new(safeModel, "unknown", "inconclusive", detail, status);
    }

    public async IAsyncEnumerable<string> StreamChatAsync(string providerId, IReadOnlyList<AiChatMessage> messages,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellation = default)
    {
        if (messages.Count == 0 || messages.Sum(message => message.Content.Length) > MaxInputCharacters)
            throw new ArgumentException("AI input is empty or exceeds the native limit.", nameof(messages));
        if (messages.Any(message => message.Role is not ("system" or "user" or "assistant") || message.Content.Length > MaxInputCharacters))
            throw new ArgumentException("AI message role or content is invalid.", nameof(messages));
        ValidateImages(messages);
        var provider = GetProvider(providerId);
        var payload = new JsonObject {
            ["model"] = provider.Model,
            ["stream"] = true,
            ["messages"] = new JsonArray(messages.Select(ToJson).ToArray())
        };
        using var response = await SendAsync(HttpMethod.Post, Endpoint(provider.BaseUrl, "chat/completions"), GetToken(providerId), payload, cancellation);
        response.EnsureSuccessStatusCode();
        using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var emitted = 0;
        while (await reader.ReadLineAsync(cancellation) is { } line)
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

    private static async Task<string> ReadErrorMessageAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        var body = await response.Content.ReadAsStringAsync(cancellation);
        if (body.Length > 4096) body = body[..4096];
        try
        {
            var json = JsonNode.Parse(body);
            var message = json?["error"]?["message"]?.GetValue<string>() ?? json?["message"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(message)) return message[..Math.Min(message.Length, 500)];
        }
        catch (JsonException) { }
        return $"Provider returned HTTP {(int)response.StatusCode}.";
    }

    private AiProviderProfile GetProvider(string id) => ParseProvider(store.Find("aiProviders", id) ?? throw new KeyNotFoundException("AI provider not found."));
    private string? GetToken(string id) => store.Find("aiProviders", id)?["tokenRef"]?.GetValue<string>() is { } reference ? store.ReadSecret(reference) : null;

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, Uri endpoint, string? token, JsonObject? payload, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(method, endpoint);
        if (!string.IsNullOrWhiteSpace(token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(payload == null ? "application/json" : "text/event-stream"));
        if (payload != null) request.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
        return await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
    }

    private static async Task<JsonObject> ReadJsonAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        response.EnsureSuccessStatusCode();
        var text = await response.Content.ReadAsStringAsync(cancellation);
        if (text.Length > MaxResponseCharacters) throw new InvalidDataException("AI response exceeded the native limit.");
        return JsonNode.Parse(text)?.AsObject() ?? throw new InvalidDataException("AI provider returned invalid JSON.");
    }

    private static AiProviderProfile ParseProvider(JsonObject value)
    {
        var url = NormalizeBaseUrl(new Uri(value["baseUrl"]?.GetValue<string>() ?? throw new InvalidDataException("Missing AI base URL.")));
        return new(value["id"]?.GetValue<string>() ?? throw new InvalidDataException("Missing AI provider id."),
            value["name"]?.GetValue<string>() ?? "", url, value["model"]?.GetValue<string>() ?? "", value["enabled"]?.GetValue<bool>() ?? false,
            value["hasToken"]?.GetValue<bool>() ?? false, value["createdAt"]?.GetValue<long>() ?? 0, value["updatedAt"]?.GetValue<long>() ?? 0);
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
