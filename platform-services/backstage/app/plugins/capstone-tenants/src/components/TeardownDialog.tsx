/*
 * TeardownDialog — the REQUIRED type-the-name-to-confirm guard for a destructive teardown.
 *
 * Safety contract (tested in TeardownDialog.test.tsx):
 *  - the "Delete tenant" button is DISABLED until the admin types the tenant's exact name,
 *  - the dialog states plainly that this is irreversible + cascade-deletes the whole tenant,
 *  - on confirm it calls onConfirm({ confirmName, archiveRepo }); while in flight the button
 *    shows a busy state and cannot be re-clicked,
 *  - on success it surfaces the teardown PR URL and the honest "nothing is freed until you
 *    merge this PR" message (teardown is async — the Crossplane cascade runs post-merge),
 *  - on error it surfaces the backend message (e.g. 403 not-admin) without closing.
 */
import { useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Link,
  TextField,
  Typography,
} from '@material-ui/core';
import { TenantSummary, TeardownResult } from '../api';

export interface TeardownDialogProps {
  tenant: TenantSummary;
  open: boolean;
  onClose: () => void;
  onConfirm: (input: {
    confirmName: string;
    archiveRepo: boolean;
  }) => Promise<TeardownResult>;
}

export function TeardownDialog(props: TeardownDialogProps) {
  const { tenant, open, onClose, onConfirm } = props;
  const [typed, setTyped] = useState('');
  const [archiveRepo, setArchiveRepo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<TeardownResult | undefined>();

  const matches = typed === tenant.name;

  const handleClose = () => {
    if (submitting) {
      return;
    }
    // Reset so a re-open starts clean.
    setTyped('');
    setArchiveRepo(false);
    setError(undefined);
    setResult(undefined);
    onClose();
  };

  const handleConfirm = async () => {
    if (!matches || submitting) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const res = await onConfirm({ confirmName: typed, archiveRepo });
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} aria-labelledby="teardown-dialog-title">
      <DialogTitle id="teardown-dialog-title">
        Tear down tenant “{tenant.name}”?
      </DialogTitle>
      <DialogContent>
        {result ? (
          <>
            <DialogContentText component="div">
              A teardown pull request has been opened:
            </DialogContentText>
            <Typography variant="body1" gutterBottom>
              <Link
                href={result.pullRequestUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {result.pullRequestUrl}
              </Link>
            </Typography>
            <DialogContentText component="div">
              <strong>Nothing is deleted yet.</strong> Merge this PR to start the
              teardown: ArgoCD prunes the <code>CapstoneTenant</code> and Crossplane
              cascade-deletes the whole tenant (namespaces + pods, Harbor project, Vault
              paths, database, ArgoCD apps). Reclaiming resources can take several minutes
              after merge.
              {result.topicStripped &&
                ' The tenant’s repo has been un-tagged so it drops out of the catalog.'}
              {result.repoArchived &&
                ' The tenant’s GitHub app repo has been archived.'}
            </DialogContentText>
          </>
        ) : (
          <>
            <DialogContentText component="div">
              This <strong>permanently and irreversibly</strong> de-provisions{' '}
              <code>{tenant.name}</code> (team <code>{tenant.team}</code>, app{' '}
              <code>{tenant.appName}</code>). On merge of the teardown PR, Crossplane
              cascade-deletes every resource: the per-env namespaces and all their pods
              (reclaiming cluster CPU/RAM), the Harbor project, the Vault policy/paths, any
              database grant, and the tenant’s ArgoCD apps.
            </DialogContentText>
            <DialogContentText component="div">
              Type the tenant name{' '}
              <code>{tenant.name}</code> below to confirm.
            </DialogContentText>
            <TextField
              margin="dense"
              label="Type the tenant name to confirm"
              fullWidth
              value={typed}
              onChange={e => setTyped(e.target.value)}
              disabled={submitting}
              inputProps={{ 'aria-label': 'confirm tenant name' }}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={archiveRepo}
                  onChange={e => setArchiveRepo(e.target.checked)}
                  disabled={submitting}
                  inputProps={{ 'aria-label': 'also archive github repo' }}
                />
              }
              label="Also archive the tenant’s GitHub repo"
            />
            {error && (
              <Typography variant="body2" color="error" role="alert">
                {error}
              </Typography>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          {result ? 'Close' : 'Cancel'}
        </Button>
        {!result && (
          <Button
            onClick={handleConfirm}
            disabled={!matches || submitting}
            color="secondary"
            variant="contained"
            aria-label="delete tenant"
          >
            {submitting ? 'Opening PR…' : 'Delete tenant'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
