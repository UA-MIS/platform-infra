using App.Data;
using App.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace App.Controllers;

// WidgetsController — a sample EF Core CRUD over MySQL (Pomelo). Replace Widget with
// your own entities. Every action that touches the DB is wrapped: when no database is
// configured/reachable the endpoint returns 503 (with a clear message) instead of a
// 500 stack trace, so a freshly-scaffolded app (no DATABASE_URL yet) degrades cleanly.
[ApiController]
[Route("api/widgets")]
public class WidgetsController : ControllerBase
{
    private readonly AppDbContext _db;

    public WidgetsController(AppDbContext db) => _db = db;

    public record WidgetInput(string Name, string? Description);

    // GET /api/widgets
    [HttpGet]
    public async Task<IActionResult> List()
    {
        try
        {
            var widgets = await _db.Widgets.AsNoTracking().OrderBy(w => w.Id).ToListAsync();
            return Ok(widgets);
        }
        catch (Exception ex)
        {
            return DbUnavailable(ex);
        }
    }

    // GET /api/widgets/{id}
    [HttpGet("{id:int}")]
    public async Task<IActionResult> Get(int id)
    {
        try
        {
            var widget = await _db.Widgets.FindAsync(id);
            return widget is null ? NotFound() : Ok(widget);
        }
        catch (Exception ex)
        {
            return DbUnavailable(ex);
        }
    }

    // POST /api/widgets
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] WidgetInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name))
        {
            return BadRequest(new { error = "name is required" });
        }

        try
        {
            var widget = new Widget { Name = input.Name, Description = input.Description };
            _db.Widgets.Add(widget);
            await _db.SaveChangesAsync();
            return CreatedAtAction(nameof(Get), new { id = widget.Id }, widget);
        }
        catch (Exception ex)
        {
            return DbUnavailable(ex);
        }
    }

    // PUT /api/widgets/{id}
    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] WidgetInput input)
    {
        try
        {
            var widget = await _db.Widgets.FindAsync(id);
            if (widget is null)
            {
                return NotFound();
            }

            widget.Name = input.Name;
            widget.Description = input.Description;
            await _db.SaveChangesAsync();
            return Ok(widget);
        }
        catch (Exception ex)
        {
            return DbUnavailable(ex);
        }
    }

    // DELETE /api/widgets/{id}
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        try
        {
            var widget = await _db.Widgets.FindAsync(id);
            if (widget is null)
            {
                return NotFound();
            }

            _db.Widgets.Remove(widget);
            await _db.SaveChangesAsync();
            return NoContent();
        }
        catch (Exception ex)
        {
            return DbUnavailable(ex);
        }
    }

    private ObjectResult DbUnavailable(Exception ex)
    {
        return StatusCode(503, new
        {
            error = "database unavailable",
            detail = "No reachable MySQL database. Set a DATABASE_URL secret (Secrets tab). See README.",
            message = ex.Message,
        });
    }
}
