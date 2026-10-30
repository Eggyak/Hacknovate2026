import type { Role, Ticket, User, Ward } from '../types/grievance';

export const wards: Ward[] = [
  { id: 'WARD-101', name: 'Connaught Place', district: 'New Delhi', state: 'Delhi', pincodePrefix: '110001', zone: 'Central' },
  { id: 'WARD-102', name: 'Karol Bagh', district: 'New Delhi', state: 'Delhi', pincodePrefix: '110005', zone: 'Central' },
  { id: 'WARD-103', name: 'Dwarka Sector 10', district: 'South West Delhi', state: 'Delhi', pincodePrefix: '110075', zone: 'South West' },
];

export const roles: Role[] = [
  {
    id: 'ROLE-SUPER-ADMIN', name: 'Super Admin (Nodal Officer)', description: 'National oversight and user administration.',
    permissions: ['tickets:read', 'tickets:resolve', 'tickets:reroute', 'users:manage', 'analytics:view'],
    scopeType: 'GLOBAL', isSystem: true,
  },
  {
    id: 'ROLE-CYBER-OFFICER', name: 'Cybercrime Desk Officer', description: 'Cyber & Information Security division triage.',
    permissions: ['tickets:read', 'tickets:resolve', 'tickets:reroute', 'analytics:view'],
    scopeType: 'DIVISION', divisionId: 'CYBER_INFORMATION_SECURITY', isSystem: true,
  },
  {
    id: 'ROLE-WARD-101', name: 'Ward 101 Inspector', description: 'Local grievance handling for Ward 101.',
    permissions: ['tickets:read', 'tickets:resolve', 'tickets:reroute'],
    scopeType: 'WARD', wardIds: ['WARD-101'], isSystem: true,
  },
  {
    id: 'ROLE-MULTI-WARD', name: 'Multi-Ward Supervisor', description: 'Supervises Ward 101 and Ward 102 queues.',
    permissions: ['tickets:read', 'tickets:resolve', 'tickets:reroute', 'analytics:view'],
    scopeType: 'WARD', wardIds: ['WARD-101', 'WARD-102'], isSystem: true,
  },
];

export const users: User[] = [
  { id: 'USER-001', name: 'Ananya Sharma', email: 'ananya.sharma@mha.gov.in', mobileNumber: '+91 98765 10001', roleId: 'ROLE-SUPER-ADMIN', assignedWards: [], isActive: true, avatarInitials: 'AS' },
  { id: 'USER-002', name: 'R. Karthik', email: 'karthik.r@mha.gov.in', mobileNumber: '+91 98765 10002', roleId: 'ROLE-CYBER-OFFICER', assignedWards: [], isActive: true, avatarInitials: 'RK' },
  { id: 'USER-003', name: 'Vikram Singh', email: 'vikram.singh@mha.gov.in', mobileNumber: '+91 98765 10003', roleId: 'ROLE-WARD-101', assignedWards: ['WARD-101'], isActive: true, avatarInitials: 'VS' },
  { id: 'USER-004', name: 'Meera Nair', email: 'meera.nair@mha.gov.in', mobileNumber: '+91 98765 10004', roleId: 'ROLE-MULTI-WARD', assignedWards: ['WARD-101', 'WARD-102'], isActive: true, avatarInitials: 'MN' },
];

const common = {
  complainantProfile: { otpVerified: true, gender: 'NOT_SPECIFIED' as const },
  declarationOfTruth: true,
  audioFileUrl: '/audio/demo-voice.wav',
  evidence: [] as Ticket['evidence'],
};

export const tickets: Ticket[] = [
  {
    ...common, id: 'TKT-0001', grievanceId: 'MHA-2026-001', complainantName: 'S. Lakshmi', mobileNumber: '+91 98400 11223',
    location: { state: 'Delhi', district: 'New Delhi', pincode: '110001', completeAddress: 'Block B, Connaught Place, New Delhi', coordinates: { latitude: 28.6315, longitude: 77.2167 } },
    wardId: 'WARD-101', divisionId: 'CYBER_INFORMATION_SECURITY', category: 'CYBERCRIME', status: 'PENDING', slaStatus: 'WARNING',
    submissionTimestamp: '2026-10-29T08:40:00+05:30', slaDeadline: '2026-11-19T08:40:00+05:30', detectedLanguage: 'Tamil',
    originalRegionalText: 'ஒரு போலி இணையதளத்தில் பணம் செலுத்திய பிறகு என் கணக்கிலிருந்து பணம் எடுத்துள்ளனர்.',
    translatedEnglishText: 'Money was debited from my account after I made a payment on a fake website.',
    details: { transactionId: 'UTR764829103', amountLost: 24800, fraudDateTime: '2026-10-28T19:15:00+05:30', platformUsed: 'Fake shopping website', suspectDetails: 'UPI ID: support-refund@okbank' },
  },
  {
    ...common, id: 'TKT-0002', grievanceId: 'MHA-2026-002', complainantName: 'Amit Verma', mobileNumber: '+91 98101 22334',
    location: { state: 'Delhi', district: 'New Delhi', pincode: '110005', completeAddress: 'Gali No. 4, Karol Bagh, New Delhi', coordinates: { latitude: 28.6519, longitude: 77.1909 } },
    wardId: 'WARD-102', divisionId: 'FOREIGNERS', category: 'IMMIGRATION', status: 'UNDER_INVESTIGATION', slaStatus: 'ON_TIME',
    submissionTimestamp: '2026-10-27T11:25:00+05:30', slaDeadline: '2026-11-17T11:25:00+05:30', detectedLanguage: 'Hindi',
    originalRegionalText: 'मेरे वीज़ा आवेदन की स्थिति कई सप्ताह से अपडेट नहीं हुई है।', translatedEnglishText: 'My visa application status has not been updated for several weeks.',
    details: { passportNumber: 'P8XXXX421', applicationReferenceNumber: 'VISA-DEL-26-10482', nationality: 'Indian', visaType: 'Employment Visa', issueDate: '2025-11-01', expiryDate: '2026-11-01' },
  },
  {
    ...common, id: 'TKT-0003', grievanceId: 'MHA-2026-003', complainantName: 'Farida Begum', mobileNumber: '+91 98710 45678',
    location: { state: 'Delhi', district: 'South West Delhi', pincode: '110075', completeAddress: 'Sector 10, Dwarka, New Delhi', coordinates: { latitude: 28.5812, longitude: 77.0576 } },
    wardId: 'WARD-103', divisionId: 'DISASTER_MANAGEMENT', category: 'DISASTER_RELIEF', status: 'PENDING', slaStatus: 'OVERDUE',
    submissionTimestamp: '2026-10-01T09:10:00+05:30', slaDeadline: '2026-10-22T09:10:00+05:30', detectedLanguage: 'Urdu',
    originalRegionalText: 'बाढ़ के बाद घर को नुकसान हुआ है और राहत राशि अभी तक नहीं मिली।', translatedEnglishText: 'Our home was damaged after the flood and the relief payment has not arrived yet.',
    details: { aadhaarNumber: 'XXXX-XXXX-3812', bankAccountDetails: { accountNumber: 'XXXXXX9081', ifsc: 'SBIN0000456' }, disasterName: 'Yamuna Floods 2026', damageCategory: 'House damage' },
  },
  {
    ...common, id: 'TKT-0004', grievanceId: 'MHA-2026-004', complainantName: 'Joseph D’Souza', mobileNumber: '+91 98100 67891',
    location: { state: 'Delhi', district: 'New Delhi', pincode: '110001', completeAddress: 'Barakhamba Road, New Delhi', coordinates: { latitude: 28.6291, longitude: 77.2265 } },
    wardId: 'WARD-101', divisionId: 'UT_ADMINISTRATION', category: 'UT_ADMIN', status: 'UNDER_INVESTIGATION', slaStatus: 'ON_TIME',
    submissionTimestamp: '2026-10-26T14:05:00+05:30', slaDeadline: '2026-11-16T14:05:00+05:30', detectedLanguage: 'English',
    originalRegionalText: 'Streetlights outside our block have been out for two weeks.', translatedEnglishText: 'Streetlights outside our block have been out for two weeks.',
    details: { specificUt: 'National Capital Territory of Delhi', civicDepartment: 'Public Works Department', wardOrZoneNumber: '101 / Central Zone', propertyId: 'NDMC-CP-88421' },
  },
  {
    ...common, id: 'TKT-0005', grievanceId: 'MHA-2026-005', complainantName: 'Pema Dolma', mobileNumber: '+91 98102 34567',
    location: { state: 'Delhi', district: 'New Delhi', pincode: '110005', completeAddress: 'Dev Nagar, Karol Bagh, New Delhi', coordinates: { latitude: 28.6574, longitude: 77.1991 } },
    wardId: 'WARD-102', divisionId: 'CYBER_INFORMATION_SECURITY', category: 'CYBERCRIME', status: 'PENDING', slaStatus: 'WARNING',
    submissionTimestamp: '2026-10-25T16:30:00+05:30', slaDeadline: '2026-11-15T16:30:00+05:30', detectedLanguage: 'Nepali',
    originalRegionalText: 'फोन पर बैंक अधिकारी बनकर ओटीपी पूछा और खाते से पैसे निकाल लिए।', translatedEnglishText: 'Someone posed as a bank officer on the phone, asked for an OTP, and withdrew money from my account.',
    details: { transactionId: 'UPI26102577351', amountLost: 7350, fraudDateTime: '2026-10-25T15:52:00+05:30', platformUsed: 'Phone call and UPI', suspectDetails: 'Phone: +91 70XXX 29184; UPI: verify-bank@upi' },
  },
  {
    ...common, id: 'TKT-0006', grievanceId: 'MHA-2026-006', complainantName: 'Nandita Rao', mobileNumber: '+91 98103 56789',
    location: { state: 'Delhi', district: 'South West Delhi', pincode: '110075', completeAddress: 'Sector 12, Dwarka, New Delhi', coordinates: { latitude: 28.5928, longitude: 77.0478 } },
    wardId: 'WARD-103', divisionId: 'FOREIGNERS', category: 'IMMIGRATION', status: 'RESOLVED', slaStatus: 'ON_TIME',
    submissionTimestamp: '2026-10-20T10:00:00+05:30', slaDeadline: '2026-11-10T10:00:00+05:30', detectedLanguage: 'Kannada',
    originalRegionalText: 'ನನ್ನ OCI ಕಾರ್ಡ್ ನವೀಕರಣ ಅರ್ಜಿ ಬಾಕಿಯಲ್ಲಿದೆ. ದಯವಿಟ್ಟು ಪರಿಶೀಲಿಸಿ.', translatedEnglishText: 'My OCI card renewal application is pending. Please check its status.',
    actionTakenReport: 'Application status was verified and the applicant was notified of the document review timeline.',
    details: { passportNumber: 'N7XXXX893', applicationReferenceNumber: 'OCI-26-008631', nationality: 'Canadian', visaType: 'OCI renewal', issueDate: '2021-06-10', expiryDate: '2031-06-09' },
  },
  {
    ...common, id: 'TKT-0007', grievanceId: 'MHA-2026-007', complainantName: 'Harjeet Kaur', mobileNumber: '+91 98104 78901',
    location: { state: 'Delhi', district: 'New Delhi', pincode: '110001', completeAddress: 'Baba Kharak Singh Marg, New Delhi', coordinates: { latitude: 28.6287, longitude: 77.2074 } },
    wardId: 'WARD-101', divisionId: 'DISASTER_MANAGEMENT', category: 'DISASTER_RELIEF', status: 'PENDING', slaStatus: 'ON_TIME',
    submissionTimestamp: '2026-10-24T12:15:00+05:30', slaDeadline: '2026-11-14T12:15:00+05:30', detectedLanguage: 'Punjabi',
    originalRegionalText: 'ਬਾਰਿਸ਼ ਕਾਰਨ ਘਰ ਦੀ ਛੱਤ ਡਿੱਗ ਗਈ ਹੈ, ਮਦਦ ਦੀ ਲੋੜ ਹੈ।', translatedEnglishText: 'The roof of my house collapsed due to heavy rain and I need assistance.',
    details: { aadhaarNumber: 'XXXX-XXXX-5174', bankAccountDetails: { accountNumber: 'XXXXXX1743', ifsc: 'PUNB0012300' }, disasterName: 'Delhi Monsoon Storm 2026', damageCategory: 'House collapse' },
  },
  {
    ...common, id: 'TKT-0008', grievanceId: 'MHA-2026-008', complainantName: 'Rohit Malik', mobileNumber: '+91 98105 89012',
    location: { state: 'Delhi', district: 'New Delhi', pincode: '110005', completeAddress: 'Ajmal Khan Road, Karol Bagh, New Delhi', coordinates: { latitude: 28.6525, longitude: 77.1901 } },
    wardId: 'WARD-102', divisionId: 'UT_ADMINISTRATION', category: 'UT_ADMIN', status: 'PENDING', slaStatus: 'ON_TIME',
    submissionTimestamp: '2026-10-23T09:45:00+05:30', slaDeadline: '2026-11-13T09:45:00+05:30', detectedLanguage: 'Bengali',
    originalRegionalText: 'আমার সম্পত্তি করের রেকর্ডে ভুল বকেয়া দেখানো হচ্ছে।', translatedEnglishText: 'My property tax record is showing an incorrect outstanding balance.',
    details: { specificUt: 'National Capital Territory of Delhi', civicDepartment: 'Municipal Corporation of Delhi', wardOrZoneNumber: '102 / Central Zone', propertyId: 'MCD-KB-2026-14092' },
  },
];
