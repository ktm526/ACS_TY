import React, { useState } from 'react';
import { Card, Form, Input, Button, message, Space, Divider, Alert, Row, Col } from 'antd';
import { LockOutlined, KeyOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { updateAdminPassword } from '@/utils/configManager';

const PasswordSettings = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'success' | 'error', message: string }

  const handlePasswordChange = async (values) => {
    setLoading(true);
    setFeedback(null);
    
    try {
      const result = await updateAdminPassword(values.currentPassword, values.newPassword);
      
      if (result.success) {
        setFeedback({
          type: 'success',
          message: '패스워드가 성공적으로 변경되었습니다.'
        });
        message.success('패스워드가 성공적으로 변경되었습니다.');
        form.resetFields();
      } else {
        setFeedback({
          type: 'error',
          message: result.message || '패스워드 변경에 실패했습니다.'
        });
        message.error(result.message || '패스워드 변경에 실패했습니다.');
      }
    } catch (error) {
      console.error('패스워드 변경 오류:', error);
      const errorMessage = '패스워드 변경 중 오류가 발생했습니다.';
      setFeedback({
        type: 'error',
        message: errorMessage
      });
      message.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const validatePassword = (_, value) => {
    if (!value) {
      return Promise.reject(new Error('패스워드를 입력하세요.'));
    }
    if (value.length < 6) {
      return Promise.reject(new Error('패스워드는 최소 6자 이상이어야 합니다.'));
    }
    if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(value)) {
      return Promise.reject(new Error('패스워드는 영문자와 숫자를 포함해야 합니다.'));
    }
    return Promise.resolve();
  };

  const validateConfirmPassword = (_, value) => {
    if (!value) {
      return Promise.reject(new Error('패스워드 확인을 입력하세요.'));
    }
    if (value !== form.getFieldValue('newPassword')) {
      return Promise.reject(new Error('패스워드가 일치하지 않습니다.'));
    }
    return Promise.resolve();
  };

  const validateCurrentPassword = (_, value) => {
    if (!value) {
      return Promise.reject(new Error('현재 패스워드를 입력하세요.'));
    }
    return Promise.resolve();
  };

  return (
    <Card 
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <KeyOutlined />
          <span>패스워드 설정</span>
        </div>
      }
      bordered
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div>
          <h4>패스워드 변경</h4>
          <p style={{ color: '#666', marginBottom: 0 }}>
            보안을 위해 정기적으로 패스워드를 변경하는 것을 권장합니다.
          </p>
        </div>

        <Divider />

        {/* 피드백 메시지 */}
        {feedback && (
          <Alert
            message={feedback.message}
            type={feedback.type}
            showIcon
            icon={feedback.type === 'success' ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
            closable
            onClose={() => setFeedback(null)}
            style={{ marginBottom: '16px' }}
          />
        )}

        <Row gutter={24}>
          <Col xs={24} lg={14}>
            <Form
              form={form}
              layout="vertical"
              onFinish={handlePasswordChange}
            >
              <Form.Item
                label="현재 패스워드"
                name="currentPassword"
                rules={[
                  { validator: validateCurrentPassword }
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: '#bfbfbf' }} />}
                  placeholder="현재 패스워드를 입력하세요"
                  size="large"
                  disabled={loading}
                />
              </Form.Item>

              <Form.Item
                label="새 패스워드"
                name="newPassword"
                rules={[
                  { validator: validatePassword }
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: '#bfbfbf' }} />}
                  placeholder="새 패스워드를 입력하세요"
                  size="large"
                  disabled={loading}
                />
              </Form.Item>

              <Form.Item
                label="새 패스워드 확인"
                name="confirmPassword"
                rules={[
                  { validator: validateConfirmPassword }
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: '#bfbfbf' }} />}
                  placeholder="새 패스워드를 다시 입력하세요"
                  size="large"
                  disabled={loading}
                />
              </Form.Item>

              <Form.Item style={{ marginBottom: 0 }}>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  size="large"
                  style={{ width: '100%' }}
                  disabled={loading}
                >
                  {loading ? '변경 중...' : '패스워드 변경'}
                </Button>
              </Form.Item>
            </Form>
          </Col>

          <Col xs={24} lg={10}>
            {/* 패스워드 요구사항 - 새 패스워드 입력과 높이 맞춤 */}
            <div style={{ paddingTop: '30px' }}> {/* Form.Item label 높이만큼 패딩 추가 */}
              <div style={{ background: '#f6f8fa', padding: '16px', borderRadius: '8px', height: 'fit-content' }}>
                <h5 style={{ margin: '0 0 12px 0', color: '#24292f' }}>패스워드 요구사항</h5>
                <ul style={{ margin: 0, paddingLeft: '20px', color: '#656d76', lineHeight: '1.6' }}>
                  <li>최소 6자 이상</li>
                  <li>영문자와 숫자 포함</li>
                  <li>특수문자 사용 권장</li>
                </ul>
              </div>
            </div>
          </Col>
        </Row>
      </Space>
    </Card>
  );
};

export default PasswordSettings; 