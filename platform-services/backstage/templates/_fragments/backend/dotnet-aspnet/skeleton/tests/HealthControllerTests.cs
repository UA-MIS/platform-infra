using App.Controllers;
using App.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace App.Tests;

public class HealthControllerTests
{
    private static AppDbContext NewDb() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options);

    [Fact]
    public void Get_returns_200_with_status_ok()
    {
        using var db = NewDb();
        var controller = new HealthController(db);

        var result = controller.Get();

        var ok = Assert.IsType<OkObjectResult>(result);
        Assert.NotNull(ok.Value);
        // The anonymous payload carries a status property = "ok".
        var status = ok.Value!.GetType().GetProperty("status")!.GetValue(ok.Value);
        Assert.Equal("ok", status);
    }
}
