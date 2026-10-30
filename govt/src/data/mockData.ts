import type { Role, Ticket, Ward } from '../types/grievance';

export const wards: Ward[] = [
  { id: 'WARD-101', name: 'Connaught Place', district: 'New Delhi', state: 'Delhi', pincodePrefix: '110001', zone: 'Central' },
  { id: 'WARD-102', name: 'Karol Bagh', district: 'New Delhi', state: 'Delhi', pincodePrefix: '110005', zone: 'Central' },
  { id: 'WARD-103', name: 'Dwarka Sector 10', district: 'South West Delhi', state: 'Delhi', pincodePrefix: '110075', zone: 'South West' },
  { id: 'WARD-104', name: 'Andheri East', district: 'Mumbai Suburban', state: 'Maharashtra', pincodePrefix: '400069', zone: 'K East' },
  { id: 'WARD-105', name: 'T Nagar', district: 'Chennai', state: 'Tamil Nadu', pincodePrefix: '600017', zone: 'Central' },
  { id: 'WARD-106', name: 'Lal Chowk', district: 'Srinagar', state: 'Jammu and Kashmir', pincodePrefix: '190001', zone: 'Srinagar' },
  { id: 'WARD-107', name: 'Dispur', district: 'Kamrup Metropolitan', state: 'Assam', pincodePrefix: '781006', zone: 'Guwahati' },
  { id: 'WARD-108', name: 'Salt Lake', district: 'North 24 Parganas', state: 'West Bengal', pincodePrefix: '700091', zone: 'Bidhannagar' },
];

export const roles: Role[] = [
  {
    id: 'ROLE-SUPER-ADMIN', name: 'Staff Admin', description: 'National oversight and user administration.',
    permissions: ['tickets:read', 'tickets:resolve', 'tickets:reroute', 'users:manage', 'analytics:view'],
    scopeType: 'GLOBAL', isSystem: true,
  },
  {
    id: 'ROLE-WARD-DESK', name: 'Ward Desk Officer', description: 'Local grievance queue for assigned wards.',
    permissions: ['tickets:read', 'tickets:resolve', 'tickets:reroute'],
    scopeType: 'WARD', wardIds: ['WARD-101'], isSystem: true,
  },
  {
    id: 'ROLE-MULTI-WARD', name: 'Multi-Ward Supervisor', description: 'Supervises Ward 101 and Ward 102 queues.',
    permissions: ['tickets:read', 'tickets:resolve', 'tickets:reroute', 'analytics:view'],
    scopeType: 'WARD', wardIds: ['WARD-101', 'WARD-102'], isSystem: true,
  },
];

/** All fake and synthetic ticket fixtures removed. Only real tickets will be loaded. */
export const tickets: Ticket[] = [];
