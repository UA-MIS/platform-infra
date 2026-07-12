/*
 * The Process landing page — replaces the default catalog-as-root with a how-to for the
 * golden path. This is the first thing a team sees, so it stays focused on three things:
 * "how do I ship", "where do I find my app/database", and "where are the docs" — not a
 * restatement of the catalog (that's one click away at /catalog).
 *
 * Content here mirrors the authoritative "Next steps" text the New Project wizard itself
 * shows on completion (templates/new-project/template.yaml `output.text`), so a team sees
 * the same golden path twice — once at scaffold time, once every time they land here — and
 * the two never drift because this page is reviewed alongside template changes.
 */
import { Grid, List, ListItem, ListItemText, Typography } from '@material-ui/core';
import {
  Content,
  Header,
  InfoCard,
  Link,
  Page,
} from '@backstage/core-components';

const GOLDEN_PATH_STEPS = [
  'Create your repo with the New Project wizard — pick a stack, a layout, and a database.',
  'Clone it and edit your code (app/, or frontend/ + backend/) — leave .devops/ alone, it’s the platform contract.',
  'Open a PR — a preview environment builds automatically so reviewers can click through it.',
  'Merge to main — dev auto-deploys.',
  'Tag vX.Y.Z — staging auto-deploys; prod waits on a manual gate.',
];

export function HomePage() {
  return (
    <Page themeId="home">
      <Header
        title="Welcome to The Process"
        subtitle="The UA-MIS Capstone Developer Portal"
      />
      <Content>
        <Grid container spacing={3}>
          <Grid item xs={12} md={6}>
            <InfoCard title="Ship your first change">
              <List dense>
                {GOLDEN_PATH_STEPS.map(step => (
                  <ListItem key={step} disableGutters>
                    <ListItemText primary={step} />
                  </ListItem>
                ))}
              </List>
              <Typography variant="body2" color="textSecondary">
                Haven't created a project yet? Start with{' '}
                <Link to="/create">New Project</Link> — it wires up your repo,
                CI, and a tenant claim with no manual onboarding steps.
              </Typography>
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard title="Find your app and database">
              <Typography variant="body2" paragraph>
                Every scaffolded app and its per-environment database follow a fixed
                naming pattern, so you always know where to look:
              </Typography>
              <Typography variant="body2" component="div" paragraph>
                <code>https://&lt;app-name&gt;.capstone.uamishub.com</code>
                <br />
                your app (dev/staging/prod share the same host; the golden path
                promotes the same image between them)
              </Typography>
              <Typography variant="body2" component="div" paragraph>
                <code>&lt;team&gt;-&lt;env&gt;-db.capstone.uamishub.com</code>
                <br />
                your team's database console for a given environment (
                <code>dev</code>, <code>staging</code>, <code>prod</code>)
              </Typography>
              <Typography variant="body2" color="textSecondary">
                Look up your exact app name, repo, and links on its entry in the{' '}
                <Link to="/catalog">Catalog</Link>.
              </Typography>
            </InfoCard>
          </Grid>

          <Grid item xs={12}>
            <InfoCard title="Docs and support">
              <List dense>
                <ListItem disableGutters>
                  <ListItemText
                    primary={
                      <Link
                        to="https://github.com/UA-MIS/platform-infra/blob/main/platform-services/backstage/README.md"
                      >
                        The Process README
                      </Link>
                    }
                    secondary="How the portal itself is built and deployed"
                  />
                </ListItem>
                <ListItem disableGutters>
                  <ListItemText
                    primary={
                      <Link
                        to="https://github.com/UA-MIS/platform-infra/blob/main/platform-services/backstage/templates/new-project/template.yaml"
                      >
                        New Project wizard source
                      </Link>
                    }
                    secondary="Exactly what the wizard creates and wires up"
                  />
                </ListItem>
                <ListItem disableGutters>
                  <ListItemText
                    primary={
                      <Link to="https://github.com/UA-MIS/platform-infra">
                        platform-infra repository
                      </Link>
                    }
                    secondary="Everything else — architecture decisions, runbooks, tenant manifests"
                  />
                </ListItem>
              </List>
              <Typography variant="body2" color="textSecondary">
                Questions or something broken? Open an issue on{' '}
                <Link to="https://github.com/UA-MIS/platform-infra/issues">
                  platform-infra
                </Link>
                .
              </Typography>
            </InfoCard>
          </Grid>
        </Grid>
      </Content>
    </Page>
  );
}
