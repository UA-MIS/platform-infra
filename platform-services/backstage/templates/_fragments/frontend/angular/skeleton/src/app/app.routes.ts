import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home.component';
import { AboutComponent } from './pages/about.component';

// Client-side routes. Add a page by dropping a standalone component under pages/ and wiring
// a route here. nginx serves index.html for any unknown path (SPA fallback) so deep links
// and hard refreshes on these routes work.
export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'about', component: AboutComponent },
  { path: '**', redirectTo: '' },
];
