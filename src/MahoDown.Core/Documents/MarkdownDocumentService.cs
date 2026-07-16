using System.Text;

namespace MahoDown.Core.Documents;

public sealed class MarkdownDocumentService
{
    private static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
    private readonly Func<DateTimeOffset> _now;

    public MarkdownDocumentService(Func<DateTimeOffset>? now = null)
    {
        _now = now ?? (() => DateTimeOffset.Now);
    }

    public async Task<DocumentState> OpenAsync(string filePath, CancellationToken cancellationToken)
    {
        if (!File.Exists(filePath))
        {
            throw new FileNotFoundException("Markdown file was not found.", filePath);
        }

        var markdown = await File.ReadAllTextAsync(filePath, Utf8NoBom, cancellationToken);
        return DocumentState.FromSavedFile(filePath, markdown, _now());
    }

    public async Task<DocumentState> SaveAsync(DocumentState state, string filePath, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await File.WriteAllTextAsync(filePath, state.Markdown, Utf8NoBom, cancellationToken);
        return state.MarkSaved(filePath, _now());
    }
}
