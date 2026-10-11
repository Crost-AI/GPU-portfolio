// BotId's client half (see lib/botid-routes.ts). Next 15.3+ loads this file before the app's
// frontend code, which is where BotId wants to run: it sets up the challenge without rendering a
// <script> inside a React component (React 19 warns on that, and never runs it on the client).
// It used to be mounted as <BotIdClient> in app/layout.tsx because the app was on Next 14, which
// does not load this file at all — tests/botid-client.test.ts pins that this mount is one the
// installed Next actually loads.
import { initBotId } from 'botid/client/core'
import { BOTID_PROTECTED_ROUTES } from '@/lib/botid-routes'

initBotId({ protect: BOTID_PROTECTED_ROUTES })
