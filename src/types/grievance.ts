/** Domain types for the MHA grievance department workspace. */

export type Permission =
  | 'tickets:read'
  | 'tickets:resolve'
  | 'tickets:reroute'
  | 'users:manage'
  | 'analytics:view';

export type ScopeType = 'GLOBAL' | 'DIVISION' | 'WARD';

export type TicketStatus = 'PENDING' | 'UNDER_INVESTIGATION' | 'RESOLVED';
export type SlaStatus = 'ON_TIME' | 'WARNING' | 'OVERDUE';

export type DivisionId =
  | 'CYBER_INFORMATION_SECURITY'
  | 'FOREIGNERS'
  | 'DISASTER_MANAGEMENT'
  | 'UT_ADMINISTRATION'
  | 'FREEDOM_FIGHTERS_REHABILITATION'
  | 'CENTRAL_ARMED_POLICE_FORCES'
  | 'NGO_FCRA'
  | 'INTERNAL_SECURITY'
  | 'COUNTER_TERRORISM'
  | 'LWE_NORTH_EAST'
  | 'BORDER_MANAGEMENT'
  | 'JUDICIAL'
  | 'POLICE'
  | 'CENTRE_STATE'
  | 'INTERNAL_ADMINISTRATION';

export type TicketCategory =
  | 'CYBERCRIME'
  | 'IMMIGRATION'
  | 'DISASTER_RELIEF'
  | 'UT_ADMIN'
  | 'FREEDOM_FIGHTERS_REHABILITATION'
  | 'CAPF_MISCONDUCT'
  | 'FCRA_NGO'
  | 'INTERNAL_SECURITY'
  | 'COUNTER_TERRORISM'
  | 'LWE_NORTH_EAST'
  | 'BORDER_MANAGEMENT'
  | 'JUDICIAL'
  | 'POLICE'
  | 'CENTRE_STATE'
  | 'INTERNAL_DIVISIONS';

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

export interface Location {
  state: string;
  district: string;
  pincode: string;
  completeAddress: string;
  coordinates: GeoCoordinates;
}

export interface Ward {
  id: string;
  name: string;
  district: string;
  state: string;
  pincodePrefix: string;
  zone?: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  scopeType: ScopeType;
  /** Required for DIVISION scope. */
  divisionId?: DivisionId;
  /** Required for WARD scope; users may further restrict this list. */
  wardIds?: string[];
  isSystem: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  mobileNumber: string;
  roleId: string;
  /** Optional per-user ward assignment, used with WARD scoped roles. */
  assignedWards: string[];
  isActive: boolean;
  avatarInitials: string;
  lastSignIn?: string;
  passwordResetAt?: string;
}

export interface EvidenceAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  url: string;
}

export interface ComplainantProfile {
  otpVerified: boolean;
  gender: 'FEMALE' | 'MALE' | 'NON_BINARY' | 'NOT_SPECIFIED';
  email?: string;
}

export interface TicketBase {
  id: string;
  grievanceId: string;
  complainantName: string;
  mobileNumber: string;
  complainantProfile: ComplainantProfile;
  location: Location;
  wardId: string;
  divisionId: DivisionId;
  category: TicketCategory;
  status: TicketStatus;
  slaStatus: SlaStatus;
  submissionTimestamp: string;
  slaDeadline: string;
  detectedLanguage: string;
  declarationOfTruth: boolean;
  audioFileUrl: string;
  originalRegionalText: string;
  translatedEnglishText: string;
  evidence: EvidenceAttachment[];
  /** Optional official response entered by the handling officer. */
  actionTakenReport?: string;
}

export interface CybercrimeDetails {
  transactionId: string;
  amountLost: number;
  fraudDateTime: string;
  platformUsed: string;
  suspectDetails: string;
}

export interface ImmigrationDetails {
  passportNumber: string;
  applicationReferenceNumber: string;
  nationality: string;
  visaType: string;
  issueDate: string;
  expiryDate: string;
}

export interface DisasterReliefDetails {
  aadhaarNumber: string;
  bankAccountDetails: { accountNumber: string; ifsc: string };
  disasterName: string;
  damageCategory: string;
}

export interface UtAdminDetails {
  specificUt: string;
  civicDepartment: string;
  wardOrZoneNumber: string;
  propertyId: string;
}

export interface FreedomFightersDetails {
  ppoNumber: string;
  bankBranch: string;
  ifsc: string;
  freedomFighterName: string;
  sanctionDate: string;
}

export interface CapfMisconductDetails {
  forceName: string;
  officerName?: string;
  badgeNumber?: string;
  incidentDate: string;
  incidentLocation: string;
  misconductType: string;
}

export interface FcraNgoDetails {
  ngoName: string;
  fcraRegistrationNumber: string;
  registrationState: string;
  violationNature: string;
}

export interface InternalSecurityDetails {
  complaintNature: string;
  targetLocation: string;
  suspectOrOrganization: string;
}

export interface CounterTerrorismDetails {
  radicalizationPlatform: string;
  threatType: string;
  threatLocationOrSubject: string;
}

export interface LweNorthEastDetails {
  regionOrVillage: string;
  complaintNature: string;
  policeStationJurisdiction: string;
}

export interface BorderManagementDetails {
  borderNameOrState: string;
  villageOrPost: string;
  issueCategory: string;
}

export interface JudicialDetails {
  prisonerName: string;
  prisonerRegistrationNumber: string;
  prisonName: string;
  courtCaseOrFirNumber: string;
  petitionNature: string;
}

export interface PoliceDetails {
  officerOrNomineeName: string;
  stateCadre: string;
  requestNature: string;
}

export interface CentreStateDetails {
  statesInvolved: string[];
  disputeNature: string;
}

export interface InternalDivisionsDetails {
  queryType: string;
  referenceNumberOrDate: string;
}

/** Discriminated union keeps category payload fields statically type-safe. */
export type Ticket =
  | (TicketBase & { category: 'CYBERCRIME'; divisionId: 'CYBER_INFORMATION_SECURITY'; details: CybercrimeDetails })
  | (TicketBase & { category: 'IMMIGRATION'; divisionId: 'FOREIGNERS'; details: ImmigrationDetails })
  | (TicketBase & { category: 'DISASTER_RELIEF'; divisionId: 'DISASTER_MANAGEMENT'; details: DisasterReliefDetails })
  | (TicketBase & { category: 'UT_ADMIN'; divisionId: 'UT_ADMINISTRATION'; details: UtAdminDetails })
  | (TicketBase & { category: 'FREEDOM_FIGHTERS_REHABILITATION'; divisionId: 'FREEDOM_FIGHTERS_REHABILITATION'; details: FreedomFightersDetails })
  | (TicketBase & { category: 'CAPF_MISCONDUCT'; divisionId: 'CENTRAL_ARMED_POLICE_FORCES'; details: CapfMisconductDetails })
  | (TicketBase & { category: 'FCRA_NGO'; divisionId: 'NGO_FCRA'; details: FcraNgoDetails })
  | (TicketBase & { category: 'INTERNAL_SECURITY'; divisionId: 'INTERNAL_SECURITY'; details: InternalSecurityDetails })
  | (TicketBase & { category: 'COUNTER_TERRORISM'; divisionId: 'COUNTER_TERRORISM'; details: CounterTerrorismDetails })
  | (TicketBase & { category: 'LWE_NORTH_EAST'; divisionId: 'LWE_NORTH_EAST'; details: LweNorthEastDetails })
  | (TicketBase & { category: 'BORDER_MANAGEMENT'; divisionId: 'BORDER_MANAGEMENT'; details: BorderManagementDetails })
  | (TicketBase & { category: 'JUDICIAL'; divisionId: 'JUDICIAL'; details: JudicialDetails })
  | (TicketBase & { category: 'POLICE'; divisionId: 'POLICE'; details: PoliceDetails })
  | (TicketBase & { category: 'CENTRE_STATE'; divisionId: 'CENTRE_STATE'; details: CentreStateDetails })
  | (TicketBase & { category: 'INTERNAL_DIVISIONS'; divisionId: 'INTERNAL_ADMINISTRATION'; details: InternalDivisionsDetails });

export interface CreateRoleInput {
  name: string;
  description: string;
  permissions: Permission[];
  scopeType: ScopeType;
  divisionId?: DivisionId;
  wardIds?: string[];
}

export interface OnboardUserInput {
  name: string;
  email: string;
  mobileNumber: string;
  roleId: string;
  assignedWards: string[];
}
