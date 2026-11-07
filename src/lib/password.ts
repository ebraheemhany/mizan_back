import argon2 from "argon2";

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);

// Used when a login email does not exist, so the response takes as long as a
// wrong password and does not reveal which emails are registered.
const dummyHash = hashPassword("dummy-password-for-timing");

export async function verifyAgainstDummy(password: string) {
  await argon2.verify(await dummyHash, password);
  return false;
}
