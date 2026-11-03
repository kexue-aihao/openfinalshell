using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using OpenFinalShell.Core;

namespace OpenFinalShell.App.ViewModels;

public sealed class TransferQueueViewModel : INotifyPropertyChanged, IDisposable
{
    private readonly NativeTransferQueue queue;
    private readonly SynchronizationContext? context = SynchronizationContext.Current;
    public ObservableCollection<NativeTransferTask> Tasks { get; } = [];

    public TransferQueueViewModel(NativeTransferQueue queue)
    {
        this.queue = queue;
        foreach (var task in queue.List()) Tasks.Add(task);
        queue.Changed += OnChanged;
        queue.Removed += OnRemoved;
    }

    public Task ControlAsync(string id, string operation) => queue.ControlAsync(id, operation);
    public void ClearFinished() => queue.ClearFinished();

    private void OnChanged(NativeTransferTask task)
    {
        if (context != null && SynchronizationContext.Current != context) { context.Post(_ => OnChanged(task), null); return; }
        var index = Tasks.ToList().FindIndex(x => x.Id == task.Id);
        if (index < 0) Tasks.Add(task); else Tasks[index] = task;
        PropertyChanged?.Invoke(this, new(nameof(Tasks)));
    }

    private void OnRemoved(string id)
    {
        if (context != null && SynchronizationContext.Current != context) { context.Post(_ => OnRemoved(id), null); return; }
        var item = Tasks.FirstOrDefault(x => x.Id == id);
        if (item != null) Tasks.Remove(item);
        PropertyChanged?.Invoke(this, new(nameof(Tasks)));
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public void Dispose() { queue.Changed -= OnChanged; queue.Removed -= OnRemoved; }
}
