import {env} from 'cloudflare:workers';
import {api} from '../../../cloud/router';
export const dynamic='force-dynamic';
export function GET(request:Request){return api(request,env);}
export function POST(request:Request){return api(request,env);}
