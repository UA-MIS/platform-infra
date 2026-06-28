# EF Core migrations — note for this starter

The starter calls `db.Database.EnsureCreated()` at startup (in `Program.cs`) **only as a
convenience** so a fresh app with a configured MySQL gets the sample `Widgets` table
without any extra step. `EnsureCreated()` is **not** migration-aware — it creates the
schema once and cannot evolve it.

## Switch to real migrations before you ship schema changes

1. Install the EF Core CLI once (the `Microsoft.EntityFrameworkCore.Design` package is
   already referenced in `App.csproj`):

   ```bash
   dotnet tool install --global dotnet-ef
   ```

2. Create the first migration from the `app/` directory (point it at a dev MySQL via
   `DATABASE_URL`, or use the design-time fixed `ServerVersion` already configured):

   ```bash
   cd app
   export DATABASE_URL='Server=localhost;Port=3306;Database=app;User ID=app;Password=app;'
   dotnet ef migrations add InitialCreate
   ```

   This writes migration classes into this `Migrations/` directory (commit them).

3. Replace the `EnsureCreated()` call in `Program.cs` with `db.Database.Migrate()` so
   each deploy applies pending migrations:

   ```csharp
   // was: db.Database.EnsureCreated();
   db.Database.Migrate();
   ```

4. For every later schema change: edit your entities + `AppDbContext`, then
   `dotnet ef migrations add <Name>`, commit, and deploy. The platform applies them at
   startup (still wrapped so an unreachable DB never blocks the pod from starting).

> Connection string is always read from the `DATABASE_URL` env (or
> `ConnectionStrings__Default`) — never hardcode credentials in migrations or code.
