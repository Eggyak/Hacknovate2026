/**
 * The MHA divisions a grievance can be routed to, and the extra evidence each
 * one legally needs, transcribed from
 * "MHA Grievance Bot - Data Schema & Workflow Requirements", section 2.
 *
 * Two things live together here on purpose:
 *
 *   `fields`   the dynamic incident details the division requires, which the
 *              bot asks for one at a time once routing is decided.
 *
 *   `lexicon`  weighted surface forms used by services/classifier.js. These are
 *              written in the citizen's OWN script, not transliterated, so a
 *              complaint can be categorised with NO translation API in the
 *              loop. That matters: translation is an optional enrichment here,
 *              never a dependency of routing.
 *
 * Lexicon weights: 3 = near-decisive (a term that essentially names the
 * division), 2 = strong, 1 = supporting. See classifier.js for how they
 * combine and how ties are broken.
 */

const RX = {
  utr: '^[A-Za-z0-9]{12,22}$',
  passport: '^[A-PR-WYa-pr-wy][0-9]{7}$',
  aadhaar: '^[2-9][0-9]{11}$',
  ifsc: '^[A-Za-z]{4}0[A-Za-z0-9]{6}$',
  fcra: '^[0-9]{9}$',
};

export const DIVISIONS = [
  {
    id: 'cyber',
    name: 'Cyber & Information Security',
    native: 'साइबर एवं सूचना सुरक्षा',
    blurb: 'Cybercrime, online financial fraud, impersonation and data theft.',
    helpline: '1930',
    fields: [
      { key: 'transaction_id', label: 'Transaction ID / UTR Number', type: 'text', required: true, pattern: RX.utr, help: '12-22 letters or digits, printed on your bank statement.' },
      { key: 'amount_lost', label: 'Amount Lost', type: 'currency', required: true, min: 1, help: 'Total money lost, in rupees.' },
      { key: 'fraud_at', label: 'Date and Time of Fraud', type: 'datetime', required: true },
      { key: 'platform_used', label: 'Platform Used', type: 'text', required: true, help: 'For example WhatsApp, a fake website, a phone call.' },
      { key: 'suspect_details', label: 'Suspect Details', type: 'textarea', required: false, help: "The fraudster's bank account, UPI ID, or phone number, if you have it." },
    ],
    lexicon: {
      3: ['cyber', 'cybercrime', 'otp', 'upi', 'phishing', 'साइबर', 'ओटीपी', 'यूपीआई', 'সাইবার', 'சைபர்', 'సైబర్', 'ಸೈಬರ್', 'സൈബർ', 'સાયબર', 'ਸਾਈਬਰ', 'ସାଇବର', 'سائبر'],
      2: ['fraud', 'scam', 'hacked', 'debited', 'धोखाधड़ी', 'ठगी', 'फ्रॉड', 'बैंक', 'प्रतारणा', 'জালিয়াতি', 'প্রতারণা', 'ব্যাংক', 'மோசடி', 'வங்கி', 'మోసం', 'బ్యాంక్', 'ವಂಚನೆ', 'ಬ್ಯಾಂಕ್', 'തട്ടിപ്പ്', 'ബാങ്ക്', 'છેતરપિંડી', 'બેંક', 'ਧੋਖਾ', 'ਬੈਂਕ', 'ଠକେଇ', 'ବ୍ୟାଙ୍କ', 'دھوکہ', 'بینک'],
      1: ['money', 'transaction', 'card', 'password', 'पैसे', 'लेनदेन', 'টাকা', 'பணம்', 'డబ్బు', 'ಹಣ', 'പണം', 'પૈસા', 'ਪੈਸੇ', 'ଟଙ୍କା', 'پیسے'],
    },
  },
  {
    id: 'foreigners',
    name: 'Foreigners Division',
    native: 'विदेशी प्रभाग',
    blurb: 'OCI cards, visas, citizenship, registration and deportation.',
    fields: [
      { key: 'passport_number', label: 'Passport Number', type: 'text', required: true, pattern: RX.passport, help: 'One letter followed by 7 digits.' },
      { key: 'file_reference', label: 'File / Application Reference Number', type: 'text', required: true },
      { key: 'nationality', label: 'Nationality', type: 'text', required: true },
      { key: 'visa_type', label: 'Visa / OCI Type', type: 'text', required: true },
      { key: 'issue_expiry', label: 'Date of Issue / Expiry', type: 'text', required: false },
    ],
    lexicon: {
      3: ['oci', 'visa', 'passport', 'citizenship', 'deportation', 'वीजा', 'पासपोर्ट', 'नागरिकता', 'ভিসা', 'পাসপোর্ট', 'விசா', 'கடவுச்சீட்டு', 'వీసా', 'ವೀಸಾ', 'വിസ', 'વિઝા', 'ਵੀਜ਼ਾ', 'ଭିସା', 'ویزا'],
      2: ['foreigner', 'immigration', 'frro', 'विदेशी', 'आप्रवासन', 'বিদেশি', 'வெளிநாட்டு', 'విదేశీ', 'ವಿದೇಶಿ', 'വിദേശ', 'વિદેશી', 'ਵਿਦੇਸ਼ੀ', 'ବିଦେଶୀ', 'غیر ملکی'],
      1: ['renewal', 'embassy', 'नवीनीकरण', 'দূতাবাস'],
    },
  },
  {
    id: 'disaster',
    name: 'Disaster Management',
    native: 'आपदा प्रबंधन',
    blurb: 'NDRF response, cyclone and flood relief, compensation claims.',
    fields: [
      { key: 'aadhaar_number', label: 'Aadhaar Number', type: 'text', required: true, pattern: RX.aadhaar, sensitive: 'aadhaar', help: '12 digits. Stored masked - only the last 4 digits are retained.' },
      { key: 'bank_account', label: 'Bank Account Number', type: 'text', required: true, sensitive: 'account' },
      { key: 'bank_ifsc', label: 'IFSC Code', type: 'text', required: true, pattern: RX.ifsc },
      { key: 'disaster_name', label: 'Name of Disaster', type: 'text', required: true, help: 'For example Cyclone Dana.' },
      { key: 'damage_category', label: 'Category of Damage', type: 'select', required: true, options: ['Loss of Life', 'House Collapse', 'Crop Destruction', 'Livestock Loss', 'Injury', 'Other'] },
    ],
    lexicon: {
      3: ['cyclone', 'flood', 'earthquake', 'ndrf', 'चक्रवात', 'बाढ़', 'भूकंप', 'आपदा', 'ঘূর্ণিঝড়', 'বন্যা', 'ভূমিকম্প', 'புயல்', 'வெள்ளம்', 'நிலநடுக்கம்', 'తుఫాను', 'వరద', 'ಚಂಡಮಾರುತ', 'ಪ್ರವಾಹ', 'ചുഴലിക്കാറ്റ്', 'വെള്ളപ്പൊക്കം', 'વાવાઝોડું', 'પૂર', 'ਹੜ੍ਹ', 'ବନ୍ୟା', 'ବାତ୍ୟା', 'سیلاب'],
      2: ['relief', 'compensation', 'rescue', 'calamity', 'राहत', 'मुआवजा', 'ত্রাণ', 'ক্ষতিপূরণ', 'நிவாரணம்', 'సహాయం', 'ಪರಿಹಾರ', 'ദുരിതാശ്വാസം', 'રાહત', 'ਰਾਹਤ', 'ରିଲିଫ', 'امداد'],
      1: ['damage', 'crop', 'house', 'नुकसान', 'फसल', 'ক্ষতি', 'பயிர்', 'పంట'],
    },
  },
  {
    id: 'freedom_fighters',
    name: 'Freedom Fighters & Rehabilitation',
    native: 'स्वतंत्रता सेनानी एवं पुनर्वास',
    blurb: 'Swatantrata Sainik Samman pension, arrears and rehabilitation.',
    fields: [
      { key: 'ppo_number', label: 'PPO (Pension Payment Order) Number', type: 'text', required: true },
      { key: 'bank_branch', label: 'Bank Branch', type: 'text', required: true },
      { key: 'bank_ifsc', label: 'IFSC Code', type: 'text', required: true, pattern: RX.ifsc },
      { key: 'fighter_name', label: 'Name of Freedom Fighter', type: 'text', required: true },
      { key: 'sanction_date', label: 'Sanction Date', type: 'date', required: false },
    ],
    lexicon: {
      3: ['freedom fighter', 'ppo', 'samman pension', 'स्वतंत्रता सेनानी', 'सम्मान पेंशन', 'মুক্তিযোদ্ধা', 'சுதந்திர போராட்ட', 'స్వాతంత్ర్య సమరయోధ', 'ಸ್ವಾತಂತ್ರ್ಯ ಹೋರಾಟಗಾರ', 'સ્વતંત્રતા સેનાની', 'ਆਜ਼ਾਦੀ ਘੁਲਾਟੀਏ'],
      2: ['pension', 'arrears', 'rehabilitation', 'पेंशन', 'पुनर्वास', 'পেনশন', 'ஓய்வூதியம்', 'పెన్షన్', 'ಪಿಂಚಣಿ', 'പെൻഷൻ', 'પેન્શન', 'ਪੈਨਸ਼ਨ', 'ପେନସନ', 'پنشن'],
      1: ['sanction', 'widow', 'dependent'],
    },
  },
  {
    id: 'capf',
    name: 'Central Armed Police Forces',
    native: 'केंद्रीय सशस्त्र पुलिस बल',
    blurb: 'Conduct, service and welfare matters of CRPF, BSF, CISF, ITBP and SSB.',
    fields: [
      { key: 'force_name', label: 'Specific Force Name', type: 'select', required: true, options: ['CRPF', 'BSF', 'CISF', 'ITBP', 'SSB', 'NSG', 'Assam Rifles'] },
      { key: 'officer_details', label: 'Officer Name / Badge Number', type: 'text', required: false, help: 'If known.' },
      { key: 'incident_at', label: 'Date and Exact Location of Incident', type: 'textarea', required: true },
      { key: 'misconduct_type', label: 'Type of Misconduct', type: 'text', required: true },
    ],
    lexicon: {
      3: ['crpf', 'bsf', 'cisf', 'itbp', 'ssb', 'capf', 'सीआरपीएफ', 'बीएसएफ', 'सीआईएसएफ'],
      2: ['misconduct', 'jawan', 'paramilitary', 'दुर्व्यवहार', 'जवान', 'अर्धसैनिक', 'জওয়ান', 'ஜவான்', 'జవాన్'],
      1: ['posting', 'transfer', 'barrack', 'तैनाती'],
    },
  },
  {
    id: 'fcra',
    name: 'NGOs & Foreign Contribution (FCRA)',
    native: 'एनजीओ एवं विदेशी अंशदान',
    blurb: 'FCRA registration, renewal, returns and violations by associations.',
    fields: [
      { key: 'ngo_name', label: 'NGO Name', type: 'text', required: true },
      { key: 'fcra_number', label: 'FCRA Registration Number', type: 'text', required: true, pattern: RX.fcra, help: '9 digits.' },
      { key: 'registration_state', label: 'State of Registration', type: 'text', required: true },
      { key: 'violation_nature', label: 'Nature of Violation', type: 'textarea', required: true },
    ],
    lexicon: {
      3: ['fcra', 'ngo', 'foreign contribution', 'एनजीओ', 'विदेशी अंशदान', 'এনজিও', 'தன்னார்வ', 'ఎన్జీఓ'],
      2: ['trust', 'society', 'donation', 'charitable', 'न्यास', 'चंदा', 'দান', 'நன்கொடை', 'విరాళం', 'ದೇಣಿಗೆ', 'സംഭാവന'],
      1: ['registration', 'renewal', 'audit', 'पंजीकरण'],
    },
  },
  {
    id: 'ut',
    name: 'Union Territory Administration',
    native: 'केंद्र शासित प्रदेश प्रशासन',
    blurb: 'Civic and administrative matters in the Union Territories.',
    fields: [
      { key: 'specific_ut', label: 'Specific Union Territory', type: 'select', required: true, options: ['Delhi', 'Chandigarh', 'Puducherry', 'Jammu & Kashmir', 'Ladakh', 'Andaman & Nicobar Islands', 'Lakshadweep', 'Dadra & Nagar Haveli and Daman & Diu'] },
      { key: 'civic_department', label: 'Civic Department', type: 'text', required: true, help: 'For example the Municipal Corporation.' },
      { key: 'ward_zone', label: 'Ward / Zone Number', type: 'text', required: false },
      { key: 'property_id', label: 'Property ID / Tax Number', type: 'text', required: false },
    ],
    lexicon: {
      3: ['union territory', 'municipal corporation', 'केंद्र शासित', 'नगर निगम', 'পৌর', 'மாநகராட்சி', 'మున్సిపల్'],
      2: ['ward', 'civic', 'garbage', 'sewage', 'street light', 'वार्ड', 'कचरा', 'नाली', 'আবর্জনা', 'குப்பை', 'చెత్త', 'ಕಸ', 'മാലിന്യം', 'કચરો', 'ਕੂੜਾ'],
      1: ['property tax', 'water supply', 'road', 'सड़क', 'पानी'],
    },
  },
  {
    id: 'internal_security',
    name: 'Internal Security',
    native: 'आंतरिक सुरक्षा',
    blurb: 'Arms licensing, narcotics, communal harmony and security intelligence.',
    fields: [
      { key: 'complaint_nature', label: 'Nature of Intelligence / Complaint', type: 'text', required: true, help: 'For example arms licence, narcotics, communal violence.' },
      { key: 'target_location', label: 'Target Location / State', type: 'text', required: true },
      { key: 'suspect_org', label: 'Suspect Details / Organization', type: 'textarea', required: false },
    ],
    lexicon: {
      3: ['arms licence', 'arms license', 'narcotics', 'communal violence', 'शस्त्र लाइसेंस', 'मादक पदार्थ', 'सांप्रदायिक', 'সাম্প্রদায়িক', 'மதக்கலவரம்', 'మతపరమైన'],
      2: ['drugs', 'smuggling', 'riot', 'weapon', 'हथियार', 'तस्करी', 'दंगा', 'অস্ত্র', 'ஆயுதம்', 'ఆయుధ', 'ಶಸ್ತ್ರ', 'ആയുധ', 'હથિયાર', 'ਹਥਿਆਰ'],
      1: ['intelligence', 'suspicious', 'संदिग्ध'],
    },
  },
  {
    id: 'counter_terror',
    name: 'Counter Terrorism & Counter Radicalization',
    native: 'आतंकवाद रोधी एवं कट्टरपंथ रोधी',
    blurb: 'Terror financing, radicalization and online extremist content.',
    fields: [
      { key: 'radicalization_platform', label: 'Platform of Radicalization', type: 'text', required: true, help: 'Website URL or social media handle.' },
      { key: 'threat_type', label: 'Type of Threat', type: 'text', required: true },
      { key: 'threat_target', label: 'Location / Subject of Threat', type: 'textarea', required: true },
    ],
    lexicon: {
      3: ['terrorism', 'terrorist', 'radicalization', 'extremist', 'आतंकवाद', 'आतंकी', 'कट्टरपंथ', 'সন্ত্রাস', 'பயங்கரவாத', 'ఉగ్రవాద', 'ಭಯೋತ್ಪಾದನೆ', 'തീവ്രവാദ', 'આતંકવાદ', 'ਅੱਤਵਾਦ', 'ଆତଙ୍କବାଦ', 'دہشت گردی'],
      2: ['bomb', 'threat', 'jihad', 'recruitment', 'बम', 'धमकी', 'বোমা', 'குண்டு', 'బాంబు', 'ಬಾಂಬ್', 'ബോംബ്', 'બોમ્બ', 'ਬੰਬ'],
      1: ['propaganda', 'funding', 'प्रचार'],
    },
  },
  {
    id: 'lwe_ne',
    name: 'Left Wing Extremism & North East',
    native: 'वामपंथी उग्रवाद एवं पूर्वोत्तर',
    blurb: 'Naxal-affected districts, North Eastern states, insurgency and rehabilitation schemes.',
    fields: [
      { key: 'region_village', label: 'Specific Region / Village', type: 'text', required: true },
      { key: 'complaint_nature', label: 'Nature of Complaint', type: 'text', required: true, help: 'For example insurgency activity or a rehabilitation scheme issue.' },
      { key: 'police_station', label: 'Local Police Station Jurisdiction', type: 'text', required: true },
    ],
    lexicon: {
      3: ['naxal', 'maoist', 'left wing extremism', 'insurgency', 'नक्सल', 'माओवादी', 'उग्रवाद', 'নকশাল', 'মাওবাদী', 'நக்சல்', 'నక్సల్', 'ନକ୍ସଲ'],
      2: ['north east', 'manipur', 'nagaland', 'mizoram', 'tripura', 'पूर्वोत्तर', 'असम', 'অসম', 'ত্রিপুরা'],
      1: ['surrender', 'rehabilitation scheme', 'आत्मसमर्पण'],
    },
  },
  {
    id: 'border',
    name: 'Border Management',
    native: 'सीमा प्रबंधन',
    blurb: 'Border fencing, coastal security, BADP funds and border infrastructure.',
    fields: [
      { key: 'border_name', label: 'Border Name / State', type: 'text', required: true },
      { key: 'village_post', label: 'Specific Village / Post', type: 'text', required: true },
      { key: 'issue_category', label: 'Issue Category', type: 'select', required: true, options: ['Border fencing dispute', 'Coastal security', 'BADP funds', 'Border infrastructure', 'Cross-border movement', 'Other'] },
    ],
    lexicon: {
      3: ['border', 'fencing', 'badp', 'coastal security', 'सीमा', 'बाड़', 'সীমান্ত', 'எல்லை', 'సరిహద్దు', 'ಗಡಿ', 'അതിർത്തി', 'સરહદ', 'ਸਰਹੱਦ', 'ସୀମା', 'سرحد'],
      2: ['checkpost', 'infiltration', 'चौकी', 'घुसपैठ', 'অনুপ্রবেশ'],
      1: ['village', 'post', 'गांव'],
    },
  },
  {
    id: 'judicial',
    name: 'Judicial Division',
    native: 'न्यायिक प्रभाग',
    blurb: 'Mercy petitions, premature release, prison administration and extradition.',
    fields: [
      { key: 'prisoner_details', label: 'Prisoner Name & Registration Number', type: 'text', required: true },
      { key: 'prison_name', label: 'Name of Prison / Jail', type: 'text', required: true },
      { key: 'case_number', label: 'Court Case / FIR Number', type: 'text', required: true },
      { key: 'petition_nature', label: 'Nature of Petition', type: 'select', required: true, options: ['Mercy petition', 'Premature release', 'Parole', 'Transfer of prisoner', 'Extradition', 'Other'] },
    ],
    lexicon: {
      3: ['mercy petition', 'premature release', 'prisoner', 'jail', 'parole', 'दया याचिका', 'कैदी', 'जेल', 'কারাগার', 'বন্দী', 'சிறை', 'கைதி', 'ఖైదీ', 'ಜೈಲು', 'ജയിൽ', 'જેલ', 'ਜੇਲ੍ਹ', 'ଜେଲ'],
      2: ['fir', 'court', 'conviction', 'sentence', 'अदालत', 'एफआईआर', 'আদালত', 'நீதிமன்றம்', 'కోర్టు', 'ನ್ಯಾಯಾಲಯ', 'കോടതി', 'અદાલત', 'ਅਦਾਲਤ'],
      1: ['petition', 'appeal', 'याचिका'],
    },
  },
  {
    id: 'police',
    name: 'Police Divisions (IPS & Gallantry Awards)',
    native: 'पुलिस प्रभाग',
    blurb: 'IPS cadre matters, gallantry medals and serious misconduct by IPS officers.',
    fields: [
      { key: 'officer_name', label: 'Name of IPS Officer / Nominee', type: 'text', required: true },
      { key: 'state_cadre', label: 'State Cadre', type: 'text', required: true },
      { key: 'request_nature', label: 'Nature of Request', type: 'select', required: true, options: ['Severe misconduct complaint', 'Medal application', 'Cadre / posting matter', 'Other'] },
    ],
    lexicon: {
      3: ['ips officer', 'gallantry award', 'police medal', 'आईपीएस', 'वीरता पुरस्कार', 'পুলিশ পদক', 'காவல் பதக்கம்'],
      2: ['police misconduct', 'cadre', 'पुलिस', 'পুলিশ', 'காவல்துறை', 'పోలీసు', 'ಪೊಲೀಸ್', 'പോലീസ്', 'પોલીસ', 'ਪੁਲਿਸ', 'ପୋଲିସ', 'پولیس'],
      1: ['promotion', 'posting', 'पदोन्नति'],
    },
  },
  {
    id: 'centre_state',
    name: 'Centre-State Division',
    native: 'केंद्र-राज्य प्रभाग',
    blurb: 'Inter-state boundary disputes, Centre-State relations and crime statistics.',
    fields: [
      { key: 'states_involved', label: 'States Involved', type: 'text', required: true },
      { key: 'dispute_nature', label: 'Dispute Nature', type: 'select', required: true, options: ['Inter-state boundary issue', 'General crime statistics query', 'Centre-State relations', 'Other'] },
    ],
    lexicon: {
      3: ['inter-state', 'interstate boundary', 'centre state', 'अंतरराज्यीय', 'केंद्र राज्य', 'আন্তঃরাজ্য', 'மாநிலங்களுக்கிடையே'],
      2: ['boundary dispute', 'crime statistics', 'सीमा विवाद', 'अपराध आंकड़े'],
      1: ['state government', 'राज्य सरकार'],
    },
  },
  {
    id: 'internal_admin',
    name: 'Internal Divisions (Administration, Finance, International Cooperation)',
    native: 'आंतरिक प्रभाग',
    blurb: 'RTI applications, parliamentary questions, treaties and ministry administration.',
    fields: [
      { key: 'query_type', label: 'Query Type', type: 'select', required: true, options: ['RTI Application', 'Parliamentary Question', 'Treaty details', 'Administrative matter', 'Finance matter', 'Other'] },
      { key: 'reference_number', label: 'Reference Number / Date', type: 'text', required: true },
    ],
    lexicon: {
      3: ['rti', 'right to information', 'parliamentary question', 'treaty', 'सूचना का अधिकार', 'आरटीआई', 'তথ্যের অধিকার', 'தகவல் அறியும் உரிமை', 'సమాచార హక్కు'],
      2: ['ministry administration', 'international cooperation', 'मंत्रालय', 'वित्त', 'মন্ত্রণালয়'],
      1: ['reference', 'application status', 'संदर्भ'],
    },
  },
];

export const BY_ID = new Map(DIVISIONS.map((d) => [d.id, d]));

export function divisionById(id) {
  return BY_ID.get(id) || null;
}

/** Field definitions for a division, so submitted dynamic details can be validated. */
export function fieldsFor(divisionId) {
  const d = divisionById(divisionId);
  return d ? d.fields : [];
}
