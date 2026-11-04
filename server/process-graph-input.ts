import {z} from 'zod';
import {fields,operators,type ProcessGraph} from '../shared/process-graph.js';
const point={id:z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),x:z.number().int().min(0).max(2400),y:z.number().int().min(0).max(2000)};
const graphAction=z.object({title:z.string().trim().min(3).max(500),assigneeId:z.string().trim().min(1).max(100),price:z.number().min(0).max(999999999999.99),deadlineHours:z.number().int().min(1).max(8760).nullable()});
const node=z.discriminatedUnion('type',[
 z.object({...point,type:z.literal('start')}),z.object({...point,type:z.literal('end')}),
 z.object({...point,type:z.literal('condition'),config:z.object({field:z.enum(fields),operator:z.enum(operators),value:z.string().trim().max(250)})}),
 z.object({...point,type:z.literal('task'),config:graphAction})
]);
export const processGraph=z.object({nodes:z.array(node).min(1).max(24),
 edges:z.array(z.object({from:point.id,to:point.id,sourcePort:z.enum(['next','yes','no'])})).max(48)}) satisfies z.ZodType<ProcessGraph>;
