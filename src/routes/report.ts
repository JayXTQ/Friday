import {
    CategoryChannel,
    Client,
    ChannelType,
    OverwriteResolvable, TextChannel, PermissionFlagsBits, PermissionsBitField
} from "discord.js";
import { Express } from "express";
import { initialiseSteam } from "../utils/steam";
import { db, getUser, User } from "../db";
import { servers, tickets } from "../schema";
import { eq } from "drizzle-orm";
import { DiscordFetch, embed as embed_ } from "../utils/discord";
import { Locales, replacement } from "../locales";
import ids from '../../ids.json';

export default function (app: Express, client: Client) {
    app.post("/report", async (req, res) => {
        const auth = req.headers.authorization;
        const body = req.body as {
            reporterName: string;
            reporterId: string;
            reportedName: string;
            reportedId: string;
            reason: string;
            serverName: string;
            serverType: number | undefined;
        };
        console.log(`Received report: ${JSON.stringify(body)}`);
        if (!auth) return res.status(400).send("No token provided");
        const token = auth.split(" ")[1];
        const server = await db.query.servers.findFirst({ where: eq(servers.token, token) }).execute().catch(() => undefined);
        if (!server) return res.status(401).send("Can not find your server with the token you provided");
        const guild = await new DiscordFetch(client).guild(server.id);
        if (!guild) return res.status(400).send("Can not find your server");
        if (!server.category) return res.status(400).send("You need to set a ticket category! Do /config with Friday to set it up");
        const category = await new DiscordFetch(client).channel(
            server.category,
        );
        if (!category) return res.status(400).send("The category you set is invalid");
        if (category.type !== 4)
            return res.status(400).send("The category channel you sent is not a category channel");

        let discordUserId: User | null = null;

        if (body.serverType === undefined) body.serverType = 0;

        switch (body.serverType) {
            case 0: {
                const reporterIdSplit = body.reporterId.split("@");
                const type = reporterIdSplit[1];
                if (type === "discord") {
                    discordUserId = await getUser(reporterIdSplit[0]);
                } else if (type === "steam") {
                    discordUserId = await getUser(reporterIdSplit[0], true);
                } else if (type === "northwood") {
                    if(ids[body.reporterId]) {
                        discordUserId = await getUser(ids[body.reporterId]);
                    }
                }
                break;
            }
        }
        if (
            discordUserId &&
            !(await new DiscordFetch(client).member(
                server.id,
                discordUserId.id,
            ))
        )
            discordUserId = null;
        const tickets_ = await db.query.tickets.findMany({ where: eq(tickets.server, server.id)}).execute().catch(() => []);
        let nextNumber = 0;
        if(tickets_[0]) tickets_.forEach((ticket) => {
            if (ticket.ticketNo > nextNumber) nextNumber = ticket.ticketNo;
        })
        nextNumber++;
        const ticketInfo = (
            await db
                .insert(tickets)
                .values({
                    created_by: discordUserId?.id || null,
                    server: server.id,
                    steamid: body.reporterId,
                    ticketNo: nextNumber
                })
                .returning()
                .execute()
                .catch((err) => {
                    console.log(err);
                    return [null];
                })
        )[0];
        if (!ticketInfo) return res.status(500).send("Failed to create ticket in the database, contact Friday staff");

        const permissionOverwrites: OverwriteResolvable[] = [
            {
                id: guild.roles.everyone.id,
                allow: [
                    "EmbedLinks",
                    "AttachFiles",
                    "ReadMessageHistory",
                    "SendMessages",
                ],
                deny: "ViewChannel",
            },
            {
                id: client.user?.id as string,
                allow: ["ViewChannel", "ManageChannels", "ManageRoles"],
            },
        ];
        if (server.mod_role)
            permissionOverwrites.push({
                id: server.mod_role,
                allow: "ViewChannel",
            });
        if (discordUserId)
            permissionOverwrites.push({
                id: discordUserId.id,
                allow: "ViewChannel",
            });
        let channel: TextChannel;
        try {
            channel = await category.guild.channels
                .create({
                    name: `ticket-${makeNumber4Chars(nextNumber)}`,
                    type: ChannelType.GuildText,
                    parent: category,
                    permissionOverwrites,
                })
        } catch (err) {
            await db.delete(tickets).where(eq(tickets.id, ticketInfo.id)).execute().catch(() => null);
            return res.status(500).send("Failed to create channel: " + err);
        }
        await db
            .update(tickets)
            .set({ channelId: channel.id })
            .where(eq(tickets.id, ticketInfo.id))
            .execute()
            .catch(() => null);
        const serverLocale = new Locales(server.locale);
        const embed = embed_().setTitle(
            serverLocale.get((lang) => lang.ticket.embeds.title),
        );
        const embedFields: { name: string; value: string }[] = [];
        const embedFieldNames = serverLocale.getObject(
            (lang) => lang.ticket.embeds.field_names,
        );
        for (const field of Object.keys(embedFieldNames)) {
            const value = embedFieldNames[field];
            switch (field) {
                case "user": {
                    embedFields.push({
                        name: value,
                        value: `${body.reportedName} (${body.reportedId})`,
                    });
                    break;
                }
                case "reason": {
                    embedFields.push({
                        name: value,
                        value: body.reason,
                    });
                    break;
                }
                case "reporter": {
                    embedFields.push({
                        name: value,
                        value: `${body.reporterName} (${body.reporterId})\nDiscord: ${discordUserId ? `<@${discordUserId.id}>` : serverLocale.get((lang) => lang.ticket.embeds.no_user)}`,
                    });
                    break;
                }
                case "server": {
                    embedFields.push({
                        name: value,
                        value: body.serverName
                            ? body.serverName
                                  .replace(/<[^{}]*>/g, " ")
                                  .replace(/  +/g, " ")
                            : "Unknown",
                    });
                }
            }
        }
        embed.addFields(embedFields);

        let content = "";
        if(discordUserId) {
            content += `<@${discordUserId.id}>\n`;
            if(server.message) content += server.message;
            else content += serverLocale.get((lang) => lang.ticket.default_message);
        } else {
            content += serverLocale.get((lang) => lang.ticket.default_message_no_user);
        }

        await channel.send({
            content,
            embeds: [embed],
        });

        res.status(200).json({
            name: channel.name,
            inDiscord: !!discordUserId,
        });
    });
}

function makeNumber4Chars(number: number): string {
    return number.toString().padStart(4, "0");
}
