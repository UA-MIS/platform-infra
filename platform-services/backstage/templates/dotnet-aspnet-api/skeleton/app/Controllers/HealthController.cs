using App.Data;
using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

// HealthController — GET /api/health. A richer, app-level health view than the bare
// /healthz probe: reports the app name and whether the database is reachable. Returns
// 200 regardless of DB state (use /healthz for k8s probes; this is for humans/clients).
[ApiController]
[Route("api/health")]
public class HealthController : ControllerBase
{
    private readonly AppDbContext _db;

    public HealthController(AppDbContext db) => _db = db;

    [HttpGet]
    public IActionResult Get()
    {
        bool dbReachable;
        try
        {
            dbReachable = _db.Database.CanConnect();
        }
        catch
        {
            dbReachable = false;
        }

        return Ok(new
        {
            status = "ok",
            app = "${{ values.appName }}",
            database = dbReachable ? "reachable" : "unconfigured-or-unreachable",
            time = DateTimeOffset.UtcNow,
        });
    }
}
