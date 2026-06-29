using App.Models;
using Microsoft.EntityFrameworkCore;

namespace App.Data;

// AppDbContext — the EF Core context for the MySQL (Pomelo) database. Add a DbSet<>
// for each entity you persist; create a migration after schema changes (see
// app/Migrations/README.md).
public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options)
    {
    }

    public DbSet<Widget> Widgets => Set<Widget>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<Widget>(entity =>
        {
            entity.HasKey(w => w.Id);
            entity.Property(w => w.Name).IsRequired().HasMaxLength(120);
            entity.Property(w => w.Description).HasMaxLength(1000);
        });
    }
}
