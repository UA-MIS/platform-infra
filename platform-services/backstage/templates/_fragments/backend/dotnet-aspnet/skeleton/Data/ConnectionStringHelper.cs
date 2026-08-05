namespace App.Data;

// ConnectionStringHelper — normalizes DATABASE_URL for MySqlConnector / Pomelo.EntityFrameworkCore.MySql.
//
// The platform hands DATABASE_URL to every fragment as a `mysql://` URI
// (mysql://user:pass@host:port/db — see .devops/chart/overlays/*/database.externalsecret.yaml).
// ADO.NET connection-string parsing does NOT understand URI syntax — it expects
// "Server=...;Database=...;User ID=...;Password=...;" — so a raw DATABASE_URL passed
// straight to UseMySql throws System.ArgumentException: "Format of the initialization
// string does not conform to specification starting at index 0" the instant the
// DbContext is constructed (before any network connection is attempted), crashing the
// pod on every boot. This normalizes the URI to ADO.NET key=value form; a value already
// in key=value form (e.g. a local ConnectionStrings:Default) passes through unchanged.
public static class ConnectionStringHelper
{
    public static string? NormalizeMySql(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !uri.Scheme.Equals("mysql", StringComparison.OrdinalIgnoreCase))
        {
            // Not a mysql:// URI (already ADO.NET key=value form, or some other scheme) — leave as-is.
            return value;
        }

        var userInfo = uri.UserInfo.Split(':', 2);
        var user = Uri.UnescapeDataString(userInfo[0]);
        var password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : string.Empty;
        var database = uri.AbsolutePath.TrimStart('/');
        var port = uri.Port > 0 ? uri.Port : 3306;

        return $"Server={uri.Host};Port={port};Database={database};User ID={user};Password={password};";
    }
}
