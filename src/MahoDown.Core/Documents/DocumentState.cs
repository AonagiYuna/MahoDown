namespace MahoDown.Core.Documents;

public sealed record DocumentState(
    string? FilePath,
    string Markdown,
    bool IsDirty,
    DateTimeOffset? LastSavedAt)
{
    public static DocumentState NewUntitled(string markdown = "") =>
        new(null, markdown, false, null);

    public static DocumentState FromSavedFile(string filePath, string markdown, DateTimeOffset savedAt) =>
        new(filePath, markdown, false, savedAt);

    public DocumentState WithContent(string markdown) =>
        this with { Markdown = markdown, IsDirty = true };

    public DocumentState MarkSaved(string filePath, DateTimeOffset savedAt) =>
        this with { FilePath = filePath, IsDirty = false, LastSavedAt = savedAt };

    public DocumentState MarkDirty() => this with { IsDirty = true };
}
