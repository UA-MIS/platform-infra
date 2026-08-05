using App.Controllers;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace App.Tests;

public class RootControllerTests
{
    [Fact]
    public void Get_returns_200_without_leaking_the_secret()
    {
        Environment.SetEnvironmentVariable("APP_SECRET", "shh-super-secret");
        try
        {
            var controller = new RootController();

            var result = controller.Get();

            var ok = Assert.IsType<OkObjectResult>(result);
            Assert.NotNull(ok.Value);
            var secretLoaded = ok.Value!.GetType().GetProperty("secret_loaded")!.GetValue(ok.Value);
            Assert.Equal(true, secretLoaded);
            Assert.DoesNotContain("shh-super-secret", ok.Value!.ToString());
        }
        finally
        {
            Environment.SetEnvironmentVariable("APP_SECRET", null);
        }
    }
}
