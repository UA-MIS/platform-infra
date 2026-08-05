using App.Data;
using Xunit;

namespace App.Tests;

// Regression coverage for the molly-demo incident: DATABASE_URL is delivered by the
// platform as a mysql:// URI, but MySqlConnector/Pomelo needs ADO.NET key=value syntax.
// A raw pass-through throws at DbContext construction and crash-loops the pod on every
// boot (see .devops/chart/overlays/*/database.externalsecret.yaml for the URI shape).
public class ConnectionStringHelperTests
{
    [Fact]
    public void NormalizeMySql_converts_uri_to_adonet_keyvalue_form()
    {
        var result = ConnectionStringHelper.NormalizeMySql(
            "mysql://molly_demo_dev:OcBvFI0gmEkd2F89ufiDakgihu1@capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local:3306/molly_demo_dev");

        Assert.Equal(
            "Server=capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local;Port=3306;Database=molly_demo_dev;User ID=molly_demo_dev;Password=OcBvFI0gmEkd2F89ufiDakgihu1;",
            result);
    }

    [Fact]
    public void NormalizeMySql_decodes_percent_encoded_credentials()
    {
        var result = ConnectionStringHelper.NormalizeMySql("mysql://user:p%40ss@host:3306/db");

        Assert.Equal("Server=host;Port=3306;Database=db;User ID=user;Password=p@ss;", result);
    }

    [Fact]
    public void NormalizeMySql_defaults_port_3306_when_omitted()
    {
        var result = ConnectionStringHelper.NormalizeMySql("mysql://user:pass@host/db");

        Assert.Equal("Server=host;Port=3306;Database=db;User ID=user;Password=pass;", result);
    }

    [Theory]
    [InlineData("Server=localhost;Database=app;User ID=app;Password=app;")]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NormalizeMySql_passes_through_non_uri_values_unchanged(string? value)
    {
        Assert.Equal(value, ConnectionStringHelper.NormalizeMySql(value));
    }
}
