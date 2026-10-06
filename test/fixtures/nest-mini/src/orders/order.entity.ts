import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  customerEmail: string;
}
