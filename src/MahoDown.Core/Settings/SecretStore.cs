using System.Security.Cryptography;
using System.Text;

namespace MahoDown.Core.Settings;

public sealed class SecretStore
{
    private readonly string _directory;

    public SecretStore(string directory)
    {
        _directory = directory;
    }

    public async Task SetAsync(string key, string value, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_directory);
        var plain = Encoding.UTF8.GetBytes(value);
        var protectedBytes = ProtectedData.Protect(plain, optionalEntropy: null, scope: DataProtectionScope.CurrentUser);
        var path = GetPath(key);
        await File.WriteAllBytesAsync(path, protectedBytes, cancellationToken);
    }

    public async Task<string?> GetAsync(string key, CancellationToken cancellationToken)
    {
        var path = GetPath(key);
        if (!File.Exists(path))
        {
            return null;
        }

        var protectedBytes = await File.ReadAllBytesAsync(path, cancellationToken);
        var plain = ProtectedData.Unprotect(protectedBytes, optionalEntropy: null, scope: DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(plain);
    }

    public Task DeleteAsync(string key, CancellationToken cancellationToken)
    {
        var path = GetPath(key);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        return Task.CompletedTask;
    }

    private string GetPath(string key)
    {
        var safe = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32];
        return Path.Combine(_directory, $"{safe}.bin");
    }
}
