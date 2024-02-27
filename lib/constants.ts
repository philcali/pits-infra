
/**
 * Replace these fields for your own infra.
 * 
 * Requirements:
 * 1. Create a Route53 hosted zone, and copy the Zone ID and Name here
 * 2. Create an ACM wildcard certificate and verify it with Route53
 * 3. Replace the bucket names to something meaningful for you
 * 
 * Note: change ZONE_NAME, ZONE_ID, and CERTIFICATE_ID to undefined
 * to use AWS managed domain names.
 */
export const ZONE_NAME = 'pits.philcali.me';
export const ZONE_ID = 'Z0039617ZTGC84RIQHA5';
export const CERTIFICATE_ID = 'a8492ec1-ec0e-42e2-b782-2491a6e8c5f1';
export const CONSOLE_BUCKET_NAME = 'philcali-pits-console';
export const DEVICE_BUCKET_NAME = 'philcali-pinthesky-storage';