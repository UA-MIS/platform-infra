// ${{ values.appName }} — UA-MIS capstone ASP.NET Core (.NET 8) Web API starter.
//
// Proves the golden path end to end: PR -> preview, merge -> dev, tag -> staging,
// manual gate -> prod. Ships:
//   GET /healthz       : 200 "ok" — liveness/readiness probe (the .devops chart probes
//                        THIS path; DB-independent so the pod is Ready even with no DB).
//   GET /api/health    : 200 JSON — app name + whether the DB is configured/reachable.
//   /api/widgets       : a sample EF Core CRUD over MySQL (Pomelo).
//
// Edit this freely — it is YOUR app code. (Do not edit .devops/.)
//
// CONFIG (no hardcoded creds): the MySQL connection string is read from the env at
// startup, in priority order:
//   1. DATABASE_URL                         (the platform Secrets-tab / Vault key)
//   2. ConnectionStrings__Default           (.NET's standard env binding)
//   3. ConnectionStrings:Default in appsettings.json (empty by default)
// A freshly-scaffolded app has NO connection string and still starts cleanly (it
// reports the DB as unconfigured); set a DATABASE_URL secret to wire MySQL.

using App.Data;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// ---- listen address -------------------------------------------------------
// Kestrel binds the container PORT (the .devops Deployment sets PORT=8080 and the
// Service/Ingress target the same). Default to the scaffolded port for local runs.
// ASPNETCORE_URLS, if set, still wins (we only set the default when PORT is given).
var port = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrWhiteSpace(port))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

// ---- MySQL connection string (env-first, never hardcoded) -----------------
var connectionString =
    Environment.GetEnvironmentVariable("DATABASE_URL")
    ?? builder.Configuration.GetConnectionString("Default");

// Register EF Core with a FIXED ServerVersion so AddDbContext does NOT open a
// connection at startup (ServerVersion.AutoDetect would connect immediately and a
// missing/unready DB would crash the pod — defeating zero-config deploy). The first
// real query connects lazily; if there is no DB the CRUD endpoints surface a clear
// 503 while /healthz and /api/health stay up.
var serverVersion = new MySqlServerVersion(new Version(8, 0, 36));
builder.Services.AddDbContext<AppDbContext>(options =>
{
    // Use the configured string when present; a harmless placeholder otherwise so DI
    // can construct the context (no connection is made until a query runs).
    var cs = string.IsNullOrWhiteSpace(connectionString)
        ? "Server=localhost;Database=app;User ID=app;Password=app;"
        : connectionString;
    options.UseMySql(cs, serverVersion);
});

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

// Probe endpoint — DB-independent, matches the .devops chart's readiness/liveness path.
app.MapGet("/healthz", () => Results.Text("ok"));

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.MapControllers();

// Best-effort schema bootstrap for the starter: if a DB is configured AND reachable,
// ensure the sample schema exists. Wrapped so a missing/unready DB never blocks
// startup (zero-config deploy). PRODUCTION: switch EnsureCreated() to EF Core
// migrations (db.Database.Migrate()) — see app/Migrations/README.md.
var hasDb = !string.IsNullOrWhiteSpace(connectionString);
if (hasDb)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    try
    {
        if (db.Database.CanConnect())
        {
            db.Database.EnsureCreated();
        }
        else
        {
            app.Logger.LogWarning("DATABASE configured but not reachable yet — starting without schema bootstrap.");
        }
    }
    catch (Exception ex)
    {
        app.Logger.LogWarning(ex, "DATABASE schema bootstrap skipped (DB not ready).");
    }
}
else
{
    app.Logger.LogWarning("No DATABASE_URL / ConnectionStrings:Default set — starting without a database. Set a DATABASE_URL secret to enable MySQL.");
}

app.Logger.LogInformation("${{ values.appName }} listening (port env={Port}, db configured={HasDb})", port ?? "(default)", hasDb);

app.Run();

// Exposed so the integration/unit test project can reference the entry assembly.
public partial class Program { }
