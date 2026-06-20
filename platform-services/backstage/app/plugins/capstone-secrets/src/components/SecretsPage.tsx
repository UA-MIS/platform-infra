/*
 * Standalone "Secrets" nav page (fallback to the entity tab, plan §2.4). Secrets are scoped
 * to a Component you own, so the primary UX is the "Secrets" tab on a Component entity; this
 * page explains the write-only model and points there.
 */
import {
  Content,
  ContentHeader,
  Header,
  InfoCard,
  Page,
  SupportButton,
} from '@backstage/core-components';
import { Typography } from '@material-ui/core';

export function SecretsPage() {
  return (
    <Page themeId="tool">
      <Header
        title="Secrets"
        subtitle="Seal team secrets (write-only) and open a PR to your app repo"
      />
      <Content>
        <ContentHeader title="Team secrets">
          <SupportButton>
            Secrets are sealed with kubeseal and committed to your app repo as a
            SealedSecret via a pull request.
          </SupportButton>
        </ContentHeader>
        <InfoCard title="Write-only secrets">
          <Typography variant="body1" gutterBottom>
            Secrets are scoped to a component your team owns. Open the component
            in the catalog and use its <strong>Secrets</strong> tab to seal a
            secret for an environment.
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Sealed values are <strong>write-only</strong> — they cannot be read
            back here. To change a secret, set it again.
          </Typography>
        </InfoCard>
      </Content>
    </Page>
  );
}
