using App.Controllers;
using App.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace App.Tests;

// CRUD tests for WidgetsController using the EF Core in-memory provider (no real MySQL
// needed). Each test gets its own isolated in-memory database.
public class WidgetsControllerTests
{
    private static AppDbContext NewDb() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options);

    [Fact]
    public async Task Create_then_Get_round_trips_a_widget()
    {
        using var db = NewDb();
        var controller = new WidgetsController(db);

        var created = await controller.Create(new WidgetsController.WidgetInput("alpha", "first"));
        var createdResult = Assert.IsType<CreatedAtActionResult>(created);
        var widget = Assert.IsType<App.Models.Widget>(createdResult.Value);
        Assert.True(widget.Id > 0);
        Assert.Equal("alpha", widget.Name);

        var fetched = await controller.Get(widget.Id);
        var okFetched = Assert.IsType<OkObjectResult>(fetched);
        var fetchedWidget = Assert.IsType<App.Models.Widget>(okFetched.Value);
        Assert.Equal("alpha", fetchedWidget.Name);
    }

    [Fact]
    public async Task Create_rejects_blank_name_with_400()
    {
        using var db = NewDb();
        var controller = new WidgetsController(db);

        var result = await controller.Create(new WidgetsController.WidgetInput("  ", null));

        Assert.IsType<BadRequestObjectResult>(result);
    }

    [Fact]
    public async Task List_returns_all_widgets()
    {
        using var db = NewDb();
        var controller = new WidgetsController(db);
        await controller.Create(new WidgetsController.WidgetInput("a", null));
        await controller.Create(new WidgetsController.WidgetInput("b", null));

        var result = await controller.List();

        var ok = Assert.IsType<OkObjectResult>(result);
        var widgets = Assert.IsAssignableFrom<IEnumerable<App.Models.Widget>>(ok.Value);
        Assert.Equal(2, widgets.Count());
    }

    [Fact]
    public async Task Update_changes_fields()
    {
        using var db = NewDb();
        var controller = new WidgetsController(db);
        var created = (CreatedAtActionResult)await controller.Create(new WidgetsController.WidgetInput("old", null));
        var id = ((App.Models.Widget)created.Value!).Id;

        var updated = await controller.Update(id, new WidgetsController.WidgetInput("new", "desc"));

        var ok = Assert.IsType<OkObjectResult>(updated);
        var widget = Assert.IsType<App.Models.Widget>(ok.Value);
        Assert.Equal("new", widget.Name);
        Assert.Equal("desc", widget.Description);
    }

    [Fact]
    public async Task Delete_removes_a_widget()
    {
        using var db = NewDb();
        var controller = new WidgetsController(db);
        var created = (CreatedAtActionResult)await controller.Create(new WidgetsController.WidgetInput("gone", null));
        var id = ((App.Models.Widget)created.Value!).Id;

        var deleted = await controller.Delete(id);
        Assert.IsType<NoContentResult>(deleted);

        var afterGet = await controller.Get(id);
        Assert.IsType<NotFoundResult>(afterGet);
    }

    [Fact]
    public async Task Get_missing_returns_404()
    {
        using var db = NewDb();
        var controller = new WidgetsController(db);

        var result = await controller.Get(9999);

        Assert.IsType<NotFoundResult>(result);
    }
}
