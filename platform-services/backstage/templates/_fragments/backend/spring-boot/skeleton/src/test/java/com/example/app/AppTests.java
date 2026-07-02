// AppTests.java — DB-independent tests proving the backend contract holds with NO database
// wired (the default test env has no DATABASE_URL):
//   * /healthz returns 200 "ok"
//   * the data routes degrade to 503 (not 500) when DATABASE_URL is unset
//   * the mysql:// -> jdbc:mysql:// URL conversion is correct
package com.example.app;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class AppTests {

    @Autowired
    private MockMvc mvc;

    @Test
    void healthzIsOkAndDbIndependent() throws Exception {
        mvc.perform(get("/healthz"))
            .andExpect(status().isOk())
            .andExpect(content().string("ok"));
    }

    @Test
    void itemsReturn503WhenDatabaseUrlUnset() throws Exception {
        mvc.perform(get("/api/items")).andExpect(status().isServiceUnavailable());
    }

    @Test
    void apiHealthReportsUnconfiguredWithoutDb() throws Exception {
        mvc.perform(get("/api/health"))
            .andExpect(status().isOk())
            .andExpect(content().string(org.hamcrest.Matchers.containsString("\"db\":\"unconfigured\"")));
    }

    @Test
    void convertsMysqlUriToJdbcUrl() {
        assertThat(Db.toJdbcUrl("mysql://u:p@dbhost:3306/mydb"))
            .isEqualTo("jdbc:mysql://dbhost:3306/mydb");
        assertThat(Db.toJdbcUrl("mysql://u:p@dbhost/mydb"))
            .isEqualTo("jdbc:mysql://dbhost:3306/mydb");
        assertThat(Db.toJdbcUrl("mysql://u:p@dbhost:3307/mydb?useSSL=false"))
            .isEqualTo("jdbc:mysql://dbhost:3307/mydb?useSSL=false");
    }
}
