import { Routes } from '@angular/router';
import { UsersComponent } from './users/users.component';

export const routes: Routes = [
  { path: 'users', component: UsersComponent },
  {
    path: 'orders',
    children: [{ path: ':id', loadComponent: () => import('./orders/order-detail.component').then((m) => m.OrderDetailComponent) }],
  },
];
