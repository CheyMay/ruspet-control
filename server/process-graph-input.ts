import {metrics,numericOps,filterOps,taskFilters} from '../shared/process-metrics.js';
import {z} from 'zod';
import {fields,operators,type ProcessGraph} from '../shared/process-graph.js';
const point={id:z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),x:z.number().int().min(0).max(2400),y:z.number().int().min(0).max(2000)};
const graphAction=z.object({title:z.string().trim().min(3).max(500),assigneeId:z.string().trim().min(1).max(100),price:z.number().min(0).max(999999999999.99),deadlineHours:z.number().int().min(1).max(8760).nullable()});
const node=z.discriminatedUnion('type',[
 z.object({...point,type:z.literal('start')}),z.object({...point,type:z.literal('end')}),
 z.object({...point,type:z.literal('condition'),config:z.object({field:z.enum(fields),operator:z.enum(operators),value:z.string().trim().max(250)})}),
 z.object({...point,type:z.literal('task'),config:graphAction}),
 z.object({...point,type:z.literal('metric'),config:z.object({metric:z.enum(Object.keys(metrics) as (keyof typeof metrics)[]),filters:z.array(z.object({
  field:z.enum(Object.keys(taskFilters) as (keyof typeof taskFilters)[]),operator:z.enum(Object.keys(filterOps) as (keyof typeof filterOps)[]),
  value:z.string().trim().max(250),label:z.string().trim().max(80).optional()
 })).max(12),operator:z.enum(Object.keys(numericOps) as (keyof typeof numericOps)[]),threshold:z.number().finite().min(-1e12).max(1e12)})}),
 z.object({...point,type:z.literal('notify'),config:z.object({recipientId:z.string().trim().min(1).max(100),message:z.string().trim().min(3).max(220)})})
]);
export const processGraph=z.object({nodes:z.array(node).min(1).max(24),
 edges:z.array(z.object({from:point.id,to:point.id,sourcePort:z.enum(['next','yes','no'])})).max(48)}) satisfies z.ZodType<ProcessGraph>;
