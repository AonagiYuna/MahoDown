namespace MahoDown.Core.Settings;

public sealed class AppSettings
{
    public string Theme { get; set; } = "system";
    public string DefaultMode { get; set; } = "rich";
    public string DefaultImageHost { get; set; } = "local";
    public double FontSize { get; set; } = 15;
    public double LineHeight { get; set; } = 1.9;
    public string LineWidth { get; set; } = "standard";
    public bool AutoPairBrackets { get; set; } = true;
    public bool ExpandMarkdownOnCaret { get; set; } = true;
    public bool StripPasteFormatting { get; set; } = true;
    public bool AutoSpaceCjk { get; set; }
    public int AutoSnapshotMinutes { get; set; } = 30;
    public bool FollowSystemAccent { get; set; } = true;
    public bool PasteUploadImages { get; set; } = true;
    public bool KeepLocalOnUploadFailure { get; set; } = true;
    public List<string> RecentFiles { get; set; } = new();
    public Dictionary<string, Dictionary<string, string>> ImageHostConfigs { get; set; } = new();
}
