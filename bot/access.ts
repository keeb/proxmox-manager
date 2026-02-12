import { GuildMember } from "discord.js";

export function hasRequiredRole(member: GuildMember | null, roleName: string): boolean {
  if (!member) return false;
  return member.roles.cache.some((role) => role.name === roleName);
}
