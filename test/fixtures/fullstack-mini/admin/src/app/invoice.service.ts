import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../environments/environment';

@Injectable({ providedIn: 'root' })
export class InvoiceService {
  constructor(private http: HttpClient) {}

  list() {
    return this.http.get(`${environment.apiUrl}/invoices`);
  }

  userDetail(id: number) {
    return this.http.get(environment.apiUrl + '/users/' + id);
  }
}
