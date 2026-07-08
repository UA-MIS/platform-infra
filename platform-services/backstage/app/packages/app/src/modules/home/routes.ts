import { createRouteRef } from '@backstage/frontend-plugin-api';

// Not exported beyond this module — this is the root ("/") mount point for the landing
// page only, mirroring plugins/capstone-tenants/src/routes.ts.
export const rootRouteRef = createRouteRef();
