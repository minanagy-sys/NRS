const { PrismaClient } = require('@prisma/client');

/** One client for the process; Prisma pools connections itself. */
const prisma = new PrismaClient();

/** Prisma returns Decimal objects — the report maths wants plain numbers. */
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

/** Postgres DATE columns come back as midnight UTC; we only ever want the day. */
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/**
 * The UTC midnight Postgres stores for a DATE column.
 *
 * Takes a "YYYY-MM-DD" or a Date. It used to slice the string form of whatever it
 * was given, so passing a Date produced `String(date).slice(0,10)` — "Tue Aug 12"
 * — and an Invalid Date that only surfaced at the write.
 */
const dateOnly = (s) => new Date(`${ymd(s)}T00:00:00.000Z`);

module.exports = { prisma, num, ymd, dateOnly };
