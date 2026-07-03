/* Type declarations for the pure ESM planner composePlan.mjs (shared, no-drift core). */
export interface FragmentMeta {
  id: string;
  displayName?: string;
  category: 'frontend' | 'backend' | 'static' | 'fullstack' | 'mobile';
  language?: string;
  framework?: string;
  slots: Array<'single' | 'frontend' | 'backend' | 'mobile'>;
  defaultPort?: number;
  ingressPath?: string;
  needsDB?: boolean;
  buildType: 'container' | 'static' | 'mobile-artifact';
  dockerfile?: string;
  healthPath?: string;
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
  database: string;
  port?: number;
}

export function planComposition(input: ComposeInput): ComposePlan;
export function validateMeta(meta: FragmentMeta, where: string): FragmentMeta;
export const VALID_CATEGORIES: string[];
export const VALID_BUILDTYPES: string[];
export const VALID_DBCHOICES: string[];
