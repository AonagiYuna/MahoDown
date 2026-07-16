namespace MahoDown.Core.Bridge;

public static class BridgeCommand
{
    public const string AppEditorReady = "app:editorReady";
    public const string AppSetDirtyState = "app:setDirtyState";
    public const string AppGetRecentFiles = "app:getRecentFiles";
    public const string AppGetSettings = "app:getSettings";
    public const string AppUpdateSettings = "app:updateSettings";
    public const string AppSetSecret = "app:setSecret";

    public const string FileOpen = "file:open";
    public const string FileSave = "file:save";
    public const string FileSaveAs = "file:saveAs";
    public const string FileNew = "file:new";

    public const string ImageUpload = "image:upload";
    public const string TempWriteFile = "temp:writeFile";
    public const string FileReadAsset = "file:readAsset";
    public const string ProviderTestConnection = "provider:testConnection";

    public const string ExportFile = "export:file";
    public const string HistoryList = "history:list";
    public const string HistorySave = "history:save";
    public const string HistoryLoad = "history:load";

    public const string InvalidPayload = "invalid_payload";
    public const string InvalidRequest = "invalid_request";
    public const string UnknownCommand = "unknown_command";
    public const string PayloadTooLarge = "payload_too_large";
    public const string FileSaveFailed = "file_save_failed";
    public const string ImageUploadFailed = "image_upload_failed";
    public const string NotImplemented = "not_implemented";
}
