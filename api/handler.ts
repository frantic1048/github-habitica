import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { Readable } from 'node:stream'
import { createHmac, timingSafeEqual } from 'node:crypto'

declare global {
    /** https://github.com/DefinitelyTyped/DefinitelyTyped/issues/60924 */
    const fetch: typeof import('undici').fetch
}

enum HabiticaTaskPriority {
    Trivial = 0.1,
    Easy = 1,
    Medium = 1.5,
    Hard = 2,
}
interface HabiticaApiCallProps {
    method?: 'GET' | 'POST'
    path: string
    payload?: Record<string, unknown>
    headers?: Record<string, string>
}
/** https://habitica.com/apidoc/#api-Task-CreateUserTasks */
interface HabiticaAddTaskProps {
    /** must set for task syncing consistency */
    alias: string
    type: 'todo' | 'daily' | 'habit' | 'reward'
    text: string
    notes?: string
    priority?: HabiticaTaskPriority
}
/** https://habitica.com/apidoc/#api-Task-ScoreTask */
interface HabiticaScoreTaskProps {
    /** the task_id or alias */
    taskId: string
    direction: 'up' | 'down'
}

class HabiticaAPI {
    public static call = async ({
        method = 'GET',
        path = '',
        payload = undefined,
        headers = {},
    }: HabiticaApiCallProps) => {
        const baseUrl = 'https://habitica.com/api/v3/'
        const userId = process.env.HABITICA_USER_ID
        const apiToken = process.env.HABITICA_API_TOKEN
        /** TOOD: refine later */
        const client = 'test-github-to-habitica'

        if (!userId || !apiToken) {
            throw new Error('Missing Habitica credentials')
        }

        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                ...headers,
                'x-api-user': userId,
                'x-api-key': apiToken,
                'x-client': `${userId}-${client}`,
                ...(payload && { 'content-type': 'application/json' }),
            },
            body: payload && JSON.stringify(payload),
        })
        console.log(`
${res.status} ${method} ${baseUrl}${path}
${await res.text()}
        `)
        return res
    }

    public static createTask = async ({
        alias,
        type = 'todo',
        text,
        notes,
        priority = HabiticaTaskPriority.Easy,
    }: HabiticaAddTaskProps) => {
        return this.call({
            method: 'POST',
            path: `tasks/user`,
            payload: {
                alias,
                type,
                text,
                notes,
                priority,
            },
        })
    }

    public static scoreTask = async ({
        taskId,
        direction,
    }: HabiticaScoreTaskProps) => {
        return this.call({
            method: 'POST',
            path: `tasks/${taskId}/score/${direction}`,
        })
    }

    public static hasTask = async (alias: string) => {
        const response = await this.call({
            method: 'GET',
            path: `tasks/${alias}`,
        })

        if (response?.status === 404) {
            return false
        }
        if (response?.status === 200) {
            return true
        }
        throw new Error(`Unexpected response from: ${response?.url}`)
    }
}

class Habitica {
    static addTodo = async ({
        alias,
        text,
        notes,
        priority,
    }: {
        alias: string
        text: string
        notes?: string
        priority?: HabiticaTaskPriority
    }) => {
        const taskExists = await HabiticaAPI.hasTask(alias)
        if (taskExists) {
            console.log(`Task already exists: ${alias}`)
            return
        }
        console.log(`Creating task: ${alias}`)
        return await HabiticaAPI.createTask({
            alias,
            type: 'todo',
            text,
            notes,
            priority,
        })
    }
    static completeTodo = async (alias: string) => {
        const taskExists = await HabiticaAPI.hasTask(alias)
        if (!taskExists) {
            console.log(`Task does not exist: ${alias}`)
            return
        }
        console.log(`Completing task: ${alias}`)
        return HabiticaAPI.scoreTask({
            taskId: alias,
            direction: 'up',
        })
    }
}

async function buffer(readable: Readable) {
    const chunks = []
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    return Buffer.concat(chunks)
}

/** https://docs.github.com/en/webhooks-and-events/webhooks/securing-your-webhooks */
const verifyRequestSignature = async (request: VercelRequest) => {
    /** TODO: reorganize these */
    if (!process.env.GITHUB_WEBHOOK_SECRET) {
        throw new Error('Missing GITHUB_WEBHOOK_SECRET')
    }

    const sig = Buffer.from(`${request.headers['x-hub-signature-256']}`, 'utf8')
    let rawBody = ''
    if (request.method === 'POST') {
        rawBody = (await buffer(request)).toString('utf8')
    }
    const digest = Buffer.from(
        `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
            .update(rawBody)
            .digest('hex')}`,
        'utf8'
    )
    if (sig?.length !== digest.length || !timingSafeEqual(sig, digest)) {
        throw new Error('Invalid webhook signature')
    }
}

/** TODO: abstract to rules to apply */
const updateHabiticaTodoFromGitHub = async (request: VercelRequest) => {
    /**
     * https://docs.github.com/webhooks-and-events/webhooks/webhook-events-and-payloads#webhook-payload-object-common-properties
     */
    const payload = request.body
    if (request.headers['x-github-event'] !== 'pull_request') {
        console.error('Not a pull request event')
        return
    }

    const taskPriority =
        payload.pull_request.user.login === payload.repository.owner.login
            ? HabiticaTaskPriority.Medium
            : HabiticaTaskPriority.Easy

    // github__login-repo-number
    // github__owner-repo123-456
    const taskAlias =
        `github__${payload.repository.owner.login}-${payload.repository.name}-${payload.number}`.toLocaleLowerCase()
    const taskText = `${payload.repository.full_name}#${payload.number}`
    const taskNote = `${payload.pull_request.title}\n${payload.pull_request.html_url}`

    if (payload.action === 'opened') {
        console.log(`pull request.opened: ${taskAlias}`)
        await Habitica.addTodo({
            alias: taskAlias,
            text: taskText,
            notes: taskNote,
            priority: taskPriority,
        })
    } else if (payload.action === 'closed') {
        console.log(`pull request.closed: ${taskAlias}`)
        await Habitica.completeTodo(taskAlias)
    }
}

export default async function handler(
    request: VercelRequest,
    response: VercelResponse
) {
    try {
        await verifyRequestSignature(request)
    } catch (error) {
        return response.status(403).send('')
    }

    await updateHabiticaTodoFromGitHub(request)
    response.status(200).send('')
}
