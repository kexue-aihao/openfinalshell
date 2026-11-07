using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed record NativeAiTerminalTarget(string SessionId, string Name)
{
    public override string ToString() => Name;
}

public sealed class NativeChatLine(string role, string content) : INotifyPropertyChanged
{
    private string content = content;
    private Microsoft.UI.Xaml.Media.Imaging.BitmapImage? previewImage;
    public string Role { get; } = role;
    private string? imageDataUrl;
    public string? ImageDataUrl
    {
        get => imageDataUrl;
        set { imageDataUrl = value; if (value != null) _ = LoadPreviewAsync(value); }
    }
    public Microsoft.UI.Xaml.Media.Imaging.BitmapImage? PreviewImage { get => previewImage; private set { previewImage = value; PropertyChanged?.Invoke(this, new(nameof(PreviewImage))); } }
    public string Content { get => content; set { if (content == value) return; content = value; PropertyChanged?.Invoke(this, new(nameof(Content))); PropertyChanged?.Invoke(this, new(nameof(Summary))); } }
    public string Summary => $"{Role}: {Content}";
    private async Task LoadPreviewAsync(string dataUrl)
    {
        try
        {
            var comma = dataUrl.IndexOf(','); if (comma < 0) return;
            var bytes = Convert.FromBase64String(dataUrl[(comma + 1)..]);
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            using (var writer = new Windows.Storage.Streams.DataWriter(stream))
            {
                writer.WriteBytes(bytes); await writer.StoreAsync(); await writer.FlushAsync(); writer.DetachStream();
            }
            stream.Seek(0);
            var image = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage();
            await image.SetSourceAsync(stream);
            PreviewImage = image;
        }
        catch { /* The message still retains its text and raw attachment for retry. */ }
    }
    public event PropertyChangedEventHandler? PropertyChanged;
}

public sealed class NativeAiViewModel : INotifyPropertyChanged, IDisposable
{
    private readonly NativeAiService service;
    private CancellationTokenSource? requestCancellation;
    private AiProviderProfile? selectedProvider;
    private bool running;
    private string status = string.Empty;
    private bool streamResponses = true;
    public ObservableCollection<AiProviderProfile> Providers { get; } = [];
    public ObservableCollection<AiModelInfo> Models { get; } = [];
    public ObservableCollection<NativeChatLine> Messages { get; } = [];
    public ObservableCollection<NativeAiTerminalTarget> TerminalTargets { get; } = [];
    private string? selectedTerminalSessionId;
    public string? SelectedTerminalSessionId
    {
        get => selectedTerminalSessionId;
        set { if (selectedTerminalSessionId == value) return; selectedTerminalSessionId = value; OnPropertyChanged(); OnPropertyChanged(nameof(SelectedTerminalAvailable)); }
    }
    public bool SelectedTerminalAvailable => SelectedTerminalSessionId != null && TerminalTargets.Any(item => item.SessionId == SelectedTerminalSessionId);
    public AiProviderProfile? SelectedProvider { get => selectedProvider; set { if (selectedProvider == value) return; selectedProvider = value; OnPropertyChanged(); } }
    public bool IsRunning { get => running; private set { if (running == value) return; running = value; OnPropertyChanged(); } }
    public string Status { get => status; private set { if (status == value) return; status = value; OnPropertyChanged(); } }
    public bool StreamResponses { get => streamResponses; set { if (streamResponses == value) return; streamResponses = value; OnPropertyChanged(); } }
    public NativeAiViewModel(NativeAiService service) { this.service = service; ReloadProviders(); }

    public void ReloadProviders()
    {
        var previousId = SelectedProvider?.Id;
        Providers.Clear(); foreach (var profile in service.ListProviders()) Providers.Add(profile);
        SelectedProvider = Providers.FirstOrDefault(item => item.Id == previousId) ?? Providers.FirstOrDefault(item => item.Enabled);
    }

    public void RefreshTerminalTargets(IEnumerable<NativeAiTerminalTarget> targets)
    {
        var values = targets.ToArray();
        TerminalTargets.Clear();
        foreach (var item in values) TerminalTargets.Add(item);
        if (SelectedTerminalSessionId == null && values.Length > 0) SelectedTerminalSessionId = values[0].SessionId;
        OnPropertyChanged(nameof(SelectedTerminalAvailable));
    }

    public AiProviderProfile Save(AiProviderDraft draft)
    {
        var saved = service.SaveProvider(draft); ReloadProviders(); SelectedProvider = Providers.FirstOrDefault(item => item.Id == saved.Id); return saved;
    }

    public void DeleteSelectedProvider()
    {
        if (Providers.Count < 2) throw new InvalidOperationException("At least one AI provider must be kept.");
        var provider = SelectedProvider ?? throw new InvalidOperationException("Select an AI provider first.");
        service.DeleteProvider(provider.Id);
        ReloadProviders();
    }

    public async Task<IReadOnlyList<AiModelInfo>> DiscoverAsync(Uri url, string? token, CancellationToken cancellation = default)
    {
        var models = await service.DiscoverModelsAsync(url, token, cancellation); Models.Clear(); foreach (var model in models) Models.Add(model); Status = $"{models.Count} models"; return models;
    }

    public async Task TestAsync(CancellationToken cancellation = default)
    {
        if (SelectedProvider == null) throw new InvalidOperationException("Select a provider first.");
        var result = await service.TestConnectionAsync(SelectedProvider.Id, cancellation);
        Status = $"{result.Model} · {result.LatencyMs} ms";
    }

    public async Task SendAsync(string input)
    {
        if (SelectedProvider == null) throw new InvalidOperationException("Select an AI provider first.");
        if (string.IsNullOrWhiteSpace(input)) return;
        if (Messages.Sum(item => item.Content.Length) + input.Length > 32768) throw new InvalidOperationException("Conversation exceeds the native input limit.");
        await SendCoreAsync(input, null);
    }

    public async Task SendWithImageAsync(string input, string path)
    {
        if (SelectedProvider == null) throw new InvalidOperationException("Select an AI provider first.");
        var info = new FileInfo(path);
        if (!info.Exists || info.Length <= 0 || info.Length > 8 * 1024 * 1024) throw new InvalidOperationException("Image is missing or exceeds the 8 MiB limit.");
        var mime = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", ".gif" => "image/gif",
            _ => throw new InvalidOperationException("Choose a PNG, JPEG, WebP or GIF image.")
        };
        var bytes = await File.ReadAllBytesAsync(path);
        await SendCoreAsync(input, $"data:{mime};base64,{Convert.ToBase64String(bytes)}");
    }

    private async Task SendCoreAsync(string input, string? imageDataUrl)
    {
        if (string.IsNullOrWhiteSpace(input) && imageDataUrl == null) return;
        if (IsRunning) throw new InvalidOperationException("An AI response is already running.");
        var provider = SelectedProvider ?? throw new InvalidOperationException("Select a provider first.");
        var totalLength = Messages.Sum(item => item.Content.Length) + input.Length;
        if (totalLength > 32768) throw new InvalidOperationException("Conversation exceeds the native input limit.");
        var user = new NativeChatLine("user", input) { ImageDataUrl = imageDataUrl };
        Messages.Add(user); var assistant = new NativeChatLine("assistant", ""); Messages.Add(assistant);
        var history = Messages.Where(item => item.Content.Length > 0 || item.ImageDataUrl != null)
            .Select(item => new AiChatMessage(item.Role, item.Content, item.ImageDataUrl == null ? null : (IReadOnlyList<AiImageAttachment>)new[] { new AiImageAttachment(item.ImageDataUrl) })).ToArray();
        requestCancellation = new CancellationTokenSource(); IsRunning = true; Status = "Receiving response…";
        try
        {
            if (StreamResponses)
            {
                await foreach (var delta in service.StreamChatAsync(provider.Id, history, requestCancellation.Token)) assistant.Content += delta;
            }
            else
            {
                assistant.Content = await service.CompleteChatAsync(provider.Id, history, requestCancellation.Token);
            }
            Status = "Response completed.";
        }
        catch (OperationCanceledException) { Status = "Request canceled."; }
        catch (Exception error) { assistant.Content = string.IsNullOrEmpty(assistant.Content) ? error.Message : assistant.Content + "\n\n" + error.Message; Status = "Request failed."; }
        finally { requestCancellation?.Dispose(); requestCancellation = null; IsRunning = false; }
    }

    public Task<AiImageCapabilityResult> TestImageCapabilityAsync(Uri baseUrl, string model, string? token, CancellationToken cancellation = default) =>
        service.TestImageCapabilityAsync(baseUrl, model, token, cancellation);

    public void Cancel() => requestCancellation?.Cancel();
    public void ClearConversation() => Messages.Clear();
    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public void Dispose() { requestCancellation?.Cancel(); requestCancellation?.Dispose(); service.Dispose(); }
}
