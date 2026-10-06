import { Component } from '@angular/core';
import { UserService } from './user.service';

@Component({ selector: 'app-users', template: '<p>users</p>' })
export class UsersComponent {
  constructor(private users: UserService) {}

  ngOnInit() {
    this.users.load();
  }
}
