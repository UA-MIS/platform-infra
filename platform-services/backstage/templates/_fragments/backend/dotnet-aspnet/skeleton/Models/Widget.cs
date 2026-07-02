using System.ComponentModel.DataAnnotations;

namespace App.Models;

// Widget — the sample entity backing the /api/widgets CRUD. Replace it with your own
// domain models (and add DbSet<> entries in App.Data.AppDbContext).
public class Widget
{
    public int Id { get; set; }

    [Required]
    [MaxLength(120)]
    public string Name { get; set; } = string.Empty;

    [MaxLength(1000)]
    public string? Description { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
