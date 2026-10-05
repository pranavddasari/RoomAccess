export const normalizeEmail = (email) => (email ?? '').trim().toLowerCase();
export const allowedEmail = (email) => /^[^@\s]+@vitstudent\.ac\.in$/.test(normalizeEmail(email));
export const canAdmin = (member) => member?.status === 'ACTIVE' && member?.role === 'ADMIN';
export const denialMessages = {
 NOT_REGISTERED: "You're not currently registered as a Music Club member. Please contact a member of the Music Club board to be added.",
 DISABLED: 'Your Music Club access is currently disabled. Please contact a member of the board.',
 DOMAIN_DENIED: 'This website is available only to approved Music Club members using a @vitstudent.ac.in Google account.',
 IDENTITY_CONFLICT: 'This membership is linked to a different account. Please contact a member of the board.',
};
export async function resolveAuthorization(client, session) {
 if (!session) return { state: 'LOGIN' };
 if (!allowedEmail(session.user.email)) return { state: 'DOMAIN_DENIED' };
 const { data, error } = await client.rpc('authorize_membership');
 if (error) throw error;
 if (data?.state === 'ACTIVE' && data.member?.status === 'ACTIVE' && ['MEMBER','ADMIN'].includes(data.member.role) && data.member.auth_user_id === session.user.id) return data;
 if (denialMessages[data?.state]) return { state: data.state };
 throw new Error('Could not verify club membership. Please try again.');
}
export function memberInput(name, email, role) {
 if (!name.trim() || name.trim().length > 120) throw new Error('Enter a name of 1–120 characters.');
 if (!allowedEmail(email)) throw new Error('Use an @vitstudent.ac.in email address.');
 if (!['MEMBER','ADMIN'].includes(role)) throw new Error('Choose Member or Admin.');
 return { p_name: name.trim(), p_email: normalizeEmail(email), p_role: role };
}
export const membershipError = (error) => error?.code === '23505' ? 'This email is already registered.' : error?.message ?? 'Unable to save membership.';
