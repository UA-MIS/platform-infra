using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

// RootController — GET /. Gives a single-component backend (no frontend) something other
// than a 404 at its base URL, and proves APP_SECRET was read WITHOUT echoing it.
[ApiController]
[Route("/")]
public class RootController : ControllerBase
{
    [HttpGet]
    public IActionResult Get()
    {
        var secret = Environment.GetEnvironmentVariable("APP_SECRET") ?? "";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(secret));
        var prefix = Convert.ToHexString(hash)[..8].ToLowerInvariant();

        return Ok(new
        {
            app = "${{ values.appName }}",
            secret_loaded = secret.Length > 0,
            secret_length = secret.Length,
            secret_sha256_prefix = prefix,
        });
    }
}
