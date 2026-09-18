/**
 * Thin typed views over the portal's responses. Field names and `from_json` shapes are kept exactly as
 * jsjiit had them, because JP WebPortal's screens already destructure them (`registration_code`, `stynumber`,
 * `latest_semester()`, ...). Every model keeps `raw_response` where it had one, since the portal returns
 * plenty of fields no model bothers to name.
 */

export class RegisteredSubject {
  constructor(employee_name, employee_code, minor_subject, remarks, stytype, credits, subject_code, subject_component_code, subject_desc, subject_id, audtsubject) {
    this.employee_name = employee_name;
    this.employee_code = employee_code;
    this.minor_subject = minor_subject;
    this.remarks = remarks;
    this.stytype = stytype;
    this.credits = credits;
    this.subject_code = subject_code;
    this.subject_component_code = subject_component_code;
    this.subject_desc = subject_desc;
    this.subject_id = subject_id;
    this.audtsubject = audtsubject;
  }

  static from_json(j) {
    return new RegisteredSubject(j.employeename, j.employeecode, j.minorsubject, j.remarks, j.stytype, j.credits, j.subjectcode, j.subjectcomponentcode, j.subjectdesc, j.subjectid, j.audtsubject);
  }
}

export class Registrations {
  constructor(response) {
    this.raw_response = response;
    this.total_credits = response.totalcreditpoints;
    this.subjects = response.registrations.map(RegisteredSubject.from_json);
  }
}

export class AttendanceHeader {
  constructor(branchdesc, name, programdesc, stynumber) {
    this.branchdesc = branchdesc;
    this.name = name;
    this.programdesc = programdesc;
    this.stynumber = stynumber;
  }

  static from_json(j) {
    return new AttendanceHeader(j.branchdesc, j.name, j.programdesc, j.stynumber);
  }
}

/**
 * A registration period. The portal spells its two ids differently across endpoints (`registrationcode`
 * vs `registration_code` vs `registrationCode`), hence the fallbacks. `is_grade_card_complete` and
 * `grade_card_source` are JP WebPortal's own annotations, set by `get_semesters_for_grade_card`.
 */
export class Semester {
  constructor(registration_code, registration_id, extra = {}) {
    this.registration_code = registration_code;
    this.registration_id = registration_id;
    this.is_grade_card_complete = extra.is_grade_card_complete;
    this.grade_card_source = extra.grade_card_source;
  }

  static from_json(j, extra = {}) {
    return new Semester(
      j.registrationcode ?? j.registration_code ?? j.registrationCode,
      j.registrationid ?? j.registration_id ?? j.registrationId,
      extra,
    );
  }
}

export class AttendanceMeta {
  constructor(response) {
    this.raw_response = response;
    this.headers = response.headerlist.map(AttendanceHeader.from_json);
    this.semesters = response.semlist.map((s) => Semester.from_json(s));
  }

  latest_header() {
    return this.headers[0];
  }

  latest_semester() {
    return this.semesters[0];
  }
}

export class ExamEvent {
  constructor(exam_event_code, event_from, exam_event_desc, registration_id, exam_event_id) {
    this.exam_event_code = exam_event_code;
    this.event_from = event_from;
    this.exam_event_desc = exam_event_desc;
    this.registration_id = registration_id;
    this.exam_event_id = exam_event_id;
  }

  static from_json(j) {
    return new ExamEvent(j.exameventcode, j.eventfrom, j.exameventdesc, j.registrationid, j.exameventid);
  }
}
