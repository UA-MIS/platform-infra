/*
 * The create/update (rotate) form (plan §2.4). Write-only UX:
 *  - the VALUE is a password input, never echoed back, never read from the server.
 *  - submitting an existing key = overwrite/rotate (same path; the backend force-updates).
 *  - on success, the opened PR URL(s) are surfaced so the team can review + merge.
 * Honest copy makes the write-only contract explicit; there is no "reveal" affordance.
 */
import { useState } from 'react';
import {
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormHelperText,
  TextField,
  Typography,
  Link,
  makeStyles,
} from '@material-ui/core';
import { InfoCard } from '@backstage/core-components';
import { SealSecretResult } from '../api';

const ENVS = ['dev', 'staging', 'prod'] as const;

const useStyles = makeStyles(theme => ({
  field: { marginBottom: theme.spacing(2) },
  actions: { marginTop: theme.spacing(2) },
  result: { marginTop: theme.spacing(2) },
}));

export function SecretsForm(props: {
  onSeal: (input: {
    key: string;
    value: string;
    envs: string[];
  }) => Promise<SealSecretResult>;
  disabled?: boolean;
  disabledReason?: string;
  /**
   * EDIT mode: when set, the form pre-fills + locks the key (you're re-sealing an existing
   * secret) and targets the given env(s). "Edit" is a transparent re-seal — enter a new value
   * → the same POST /seal overwrites the SealedSecret (write-only, so the old value is never
   * shown; you just set a new one).
   */
  initialKey?: string;
  initialEnvs?: string[];
}) {
  const classes = useStyles();
  const editMode = Boolean(props.initialKey);
  const [key, setKey] = useState(props.initialKey ?? '');
  const [value, setValue] = useState('');
  const [envs, setEnvs] = useState<string[]>(
    props.initialEnvs && props.initialEnvs.length > 0
      ? props.initialEnvs
      : ['dev'],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<SealSecretResult | undefined>();

  const toggleEnv = (env: string) =>
    setEnvs(prev =>
      prev.includes(env) ? prev.filter(e => e !== env) : [...prev, env],
    );

  const canSubmit =
    !props.disabled &&
    !submitting &&
    key.trim().length > 0 &&
    value.length > 0 &&
    envs.length > 0;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(undefined);
    setResult(undefined);
    try {
      const res = await props.onSeal({ key: key.trim(), value, envs });
      setResult(res);
      // Discard the plaintext from component state the instant it leaves the form.
      setValue('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <InfoCard title={editMode ? `Edit secret: ${props.initialKey}` : 'Seal a secret'}>
      <Typography variant="body2" color="textSecondary" gutterBottom>
        Secrets are <strong>write-only</strong> here — sealed values cannot be
        read back. To change a secret, set it again. On submit, a pull request is
        opened on your app repo; merge it to apply.
      </Typography>

      {props.disabled && (
        <Typography variant="body2" color="error" gutterBottom>
          {props.disabledReason ??
            'You do not have permission to seal secrets for this component.'}
        </Typography>
      )}

      <TextField
        className={classes.field}
        label="Key"
        placeholder="DATABASE_URL"
        fullWidth
        value={key}
        // In edit mode the key is fixed (you're re-sealing THIS secret) — lock it.
        disabled={props.disabled || submitting || editMode}
        onChange={e => setKey(e.target.value)}
        inputProps={{ 'aria-label': 'secret key' }}
        helperText={
          editMode
            ? 'Re-sealing this key — enter a new value below.'
            : 'The secret key (becomes the SealedSecret name + data key).'
        }
      />

      <TextField
        className={classes.field}
        label="Value"
        type="password"
        fullWidth
        value={value}
        disabled={props.disabled || submitting}
        onChange={e => setValue(e.target.value)}
        inputProps={{ 'aria-label': 'secret value', autoComplete: 'new-password' }}
        helperText="Sealed immediately and discarded. Never stored or shown."
      />

      <FormControl
        component="fieldset"
        className={classes.field}
        disabled={props.disabled || submitting}
      >
        <FormGroup row>
          {ENVS.map(env => (
            <FormControlLabel
              key={env}
              control={
                <Checkbox
                  checked={envs.includes(env)}
                  onChange={() => toggleEnv(env)}
                  name={env}
                />
              }
              label={env}
            />
          ))}
        </FormGroup>
        <FormHelperText>
          One SealedSecret per env (namespace &lt;team&gt;-&lt;env&gt;). Preview
          (pr-&lt;n&gt;) is not a seal target.
        </FormHelperText>
      </FormControl>

      <div className={classes.actions}>
        <Button
          variant="contained"
          color="primary"
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {submitting ? 'Sealing…' : 'Seal & open PR'}
        </Button>
      </div>

      {error && (
        <Typography
          className={classes.result}
          variant="body2"
          color="error"
          role="alert"
        >
          {error}
        </Typography>
      )}

      {result && (
        <div className={classes.result}>
          <Typography variant="subtitle2" gutterBottom>
            Pull request{result.pullRequestUrls.length > 1 ? 's' : ''} opened —
            review &amp; merge:
          </Typography>
          {result.pullRequestUrls.map(url => (
            <div key={url}>
              <Link href={url} target="_blank" rel="noopener noreferrer">
                {url}
              </Link>
            </div>
          ))}
        </div>
      )}
    </InfoCard>
  );
}
