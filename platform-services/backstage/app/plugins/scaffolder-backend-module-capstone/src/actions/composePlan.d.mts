/* Type declarations for the pure ESM planner composePlan.mjs (shared, no-drift core). */
export interface FragmentMeta {
  id: string;
  displayName?: string;
  category: 'frontend' | 'backend' | 'static' | 'fullstack' | 'mobile' | 'blank';
  language?: string;
  framework?: string;
  slots: Array<'single' | 'frontend' | 'backend' | 'mobile'>;
  defaultPort?: number;
  ingressPath?: string;
  needsDB?: boolean;
  buildType: 'container' | 'static' | 'mobile-artifact';
  dockerfile?: string;
  healthPath?: string;
  /** Deploy-time migration command (D-123). Non-empty => the chart renders a migration
   *  initContainer running this shell command in the component's own image. */
  migrate?: string;
  notes?: string;
  [k: string]: unknown;
}

export interface PlanComponent {
  name: string;
  kind: string;
  context: string;
  dockerfile: string;
  port: number;
  path: string;
  needsDb: boolean;
  buildType: string;
  /** '' when the fragment has no deploy-time migration step. */
  migrate: string;
}

export interface PlanCopy {
  fragment: FragmentMeta;
  targetDir: string;
}

export interface ComposePlan {
  components: PlanComponent[];
  copies: PlanCopy[];
  database: 'none' | 'mysql' | 'postgres';
  dbWired: boolean;
  single: boolean;
}

export interface ComposeInput {
  projectType: 'web' | 'mobile';
  layout?: 'single' | 'frontend-backend';
  fragments: {
    single?: FragmentMeta;
    frontend?: FragmentMeta;
    backend?: FragmentMeta;
    mobile?: FragmentMeta;
  };
  /** Wizard DB choice (VALID_DBCHOICES). OPTIONAL (board #139): the wizard omits the
   *  `database` question entirely for DB-less stacks, so the compose action's input is
   *  `.optional()` and this may legitimately be undefined — planComposition() normalises a
   *  missing value to 'none'. */
  database?: string;
  port?: number;
}

export function planComposition(input: ComposeInput): ComposePlan;
export function validateMeta(meta: FragmentMeta, where: string): FragmentMeta;
export const VALID_CATEGORIES: string[];
export const VALID_BUILDTYPES: string[];
export const VALID_DBCHOICES: string[];
